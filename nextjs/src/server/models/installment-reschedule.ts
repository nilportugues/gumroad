// The reschedule half of SendWorkflowInstallmentWorker (app/sidekiq/send_workflow_installment_worker.rb): a job queued under
// a rule version that has since moved, or carrying the reference time it was scheduled from, checks its recipient against the
// current audience and queues itself again under the current rule. Every read is the statement Ruby sends, in Ruby's order.
// Golden: worker/jobs/__fixtures__/installment-sends.golden.json (scripts/golden/installment-sends.rb).
//
// Values Node would have to guess at throw NotPortedError, which the worker (before its first write) turns into a hand-back:
// a reference time that is not the ISO 8601 UTC form the workers write, and what audience_members_filter_params refuses.
import { Prisma, type Follower, type InstallmentRule, type Purchase, type Subscription } from "@prisma/client";

import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";

import { type AudienceMemberRow, firstAudienceMember, type FilterParams } from "./audience-member.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { audienceMembersFilterParams } from "./installment-audience.ts";
import { InstallmentPost } from "./installment-post.ts";
import { workflowDeliveryReferenceTime } from "./installment-send.ts";
import { nilReceiver } from "./offer-code.ts";
import { PurchaseRecord } from "./purchase-pricing.ts";
import { findById, findOneBy, recordIdFrom } from "./row-reads.ts";
import { castRow, column, columnIn, selectRows, table } from "./sql.ts";
import { SubscriptionRecord, type SubscriptionDeps } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

const SECOND_MS = 1000;
const RESCHEDULE_JOB = "SendWorkflowInstallmentRescheduleJob";
const UTC_ISO8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

export class FanoutNotEnqueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendWorkflowInstallmentWorker::FanoutNotEnqueuedError";
  }
}

export type RecipientIds = {
  purchaseId: JsonValue | undefined;
  followerId: JsonValue | undefined;
  affiliateUserId: JsonValue | undefined;
  subscriptionId: JsonValue | undefined;
};
export type RescheduleDeps = { now: () => Date; subscriptionDeps: SubscriptionDeps };

// `present?` of a job argument.
export function present(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

const exactlyOne = (ids: RecipientIds) =>
  [ids.purchaseId, ids.followerId, ids.affiliateUserId, ids.subscriptionId].filter(present).length === 1;

// `Time.zone.iso8601(string)`, for the UTC form `Time#iso8601` writes.
function parseReferenceTime(value: string): Date {
  if (!UTC_ISO8601.test(value))
    throw new NotPortedError(
      `a reschedule reference time that is not ISO 8601 UTC (${JSON.stringify(value)})`,
      "send_workflow_installment_worker.rb",
    );
  const time = new Date(value);
  if (Number.isNaN(time.getTime()))
    throw new NotPortedError(
      `a reschedule reference time that is not a time (${JSON.stringify(value)})`,
      "send_workflow_installment_worker.rb",
    );
  return time;
}

// `time.change(usec: 0).iso8601`
const iso8601 = (time: Date) =>
  new Date(Math.floor(time.getTime() / SECOND_MS) * SECOND_MS).toISOString().replace(".000Z", "Z");
const wholeSeconds = (time: Date) => Math.floor(time.getTime() / SECOND_MS);

// `SentPostEmail.exists?(post: installment, email:)`
async function sentPostEmailExists(post: InstallmentPost, email: string | null): Promise<boolean> {
  const emailCondition =
    email === null
      ? Prisma.sql`${column("sent_post_emails", "email")} IS NULL`
      : Prisma.sql`${column("sent_post_emails", "email")} = ${email}`;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("sent_post_emails")} WHERE ${column("sent_post_emails", "post_id")} = ${post.id} AND ${emailCondition} LIMIT 1`,
  );
  return rows.length > 0;
}

// `Purchase.find_by(id:)&.original_purchase`: the sale and the subscription it belongs to.
async function originalPurchaseOf(
  purchaseId: JsonValue | undefined,
  deps: RescheduleDeps,
): Promise<{ sale: Purchase; subscription: SubscriptionRecord | null } | null> {
  const loaded = await findById<Purchase>("Purchase", recordIdFrom(purchaseId, "Purchase.find_by"));
  if (loaded === null) return null;
  if (loaded.subscription_id === null) return { sale: loaded, subscription: null };
  const row = await findById<Subscription>("Subscription", loaded.subscription_id);
  if (row === null) throw nilReceiver("original_purchase");
  const subscription = new SubscriptionRecord(row, deps.subscriptionDeps);
  const sale = await subscription.originalPurchase();
  return sale === null ? null : { sale, subscription };
}

// `purchase.subscription` of a purchase read a second time: the same row, which the query cache answers.
async function subscriptionOf(
  sale: Purchase,
  known: SubscriptionRecord | null,
  deps: RescheduleDeps,
): Promise<SubscriptionRecord | null> {
  if (sale.subscription_id === null) return null;
  if (known !== null && known.id === sale.subscription_id) return known;
  const row = await findById<Subscription>("Subscription", sale.subscription_id);
  return row === null ? null : new SubscriptionRecord(row, deps.subscriptionDeps);
}

// `current_audience_member_and_match(installment:, email:, filters:)`
async function currentAudienceMemberAndMatch(
  post: InstallmentPost,
  email: string | null,
  filters: FilterParams | null,
): Promise<{ member: AudienceMemberRow; match: AudienceMemberRow } | null> {
  if (email === null) return null;
  const [member] = await selectRows<AudienceMemberRow>(
    Prisma.sql`SELECT ${Prisma.raw("`audience_members`.*")} FROM ${table("audience_members")} WHERE ${column("audience_members", "seller_id")} = ${post.row.seller_id} AND ${column("audience_members", "email")} = ${email.toLowerCase()} LIMIT 1`,
  );
  if (member === undefined) return null;
  const params = filters ?? (await audienceMembersFilterParams(post));
  if (post.row.seller_id === null)
    throw new NotPortedError("an installment without a seller", "send_workflow_installment_worker.rb");
  const match = await firstAudienceMember(post.row.seller_id, params, { withIds: true, ids: [Number(member.id)] });
  return match === null ? null : { member, match };
}

const withoutDates = ({ created_after: _after, created_before: _before, ...rest }: FilterParams): FilterParams => rest;

type Details = { purchases?: { id?: number }[]; follower?: { id?: number }; affiliates?: { id?: number }[] };
const detailsOf = (member: AudienceMemberRow): Details => {
  const details = typeof member.details === "string" ? (JSON.parse(member.details) as unknown) : member.details;
  return (details ?? {}) as Details;
};

// `follower_identity_matches_workflow_dates?` / `affiliate_identity_matches_workflow_dates?`
function createdWithinDates(filters: FilterParams, createdAt: Date | null): boolean {
  const after = filters.created_after ? new Date(filters.created_after) : null;
  const before = filters.created_before ? new Date(filters.created_before) : null;
  if (after === null && before === null) return true;
  if (createdAt === null)
    throw new NotPortedError("a recipient without created_at", "send_workflow_installment_worker.rb");
  if (after !== null && createdAt.getTime() <= after.getTime()) return false;
  if (before !== null && createdAt.getTime() >= before.getTime()) return false;
  return true;
}

// `DirectAffiliate.alive.where(...)` rows, in the columns ActiveRecord lists
type AffiliateRow = { id: number; created_at: Date | null; flags: number };
const AFFILIATE_COLUMNS = [
  "id",
  "seller_id",
  "affiliate_user_id",
  "affiliate_basis_points",
  "created_at",
  "updated_at",
  "deleted_at",
  "flags",
  "destination_url",
  "type",
];

// `affiliate_reference_times(installment:, member:, current_match:, affiliate_user_id:)`
async function affiliateReferenceTimes(
  post: InstallmentPost,
  member: AudienceMemberRow,
  match: AudienceMemberRow,
  affiliateUserId: bigint,
): Promise<Date[]> {
  const filters = await audienceMembersFilterParams(post);
  const ids = [
    ...new Set(
      (detailsOf(member).affiliates ?? [])
        .map((affiliate) => affiliate.id)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  const columns = Prisma.join(
    AFFILIATE_COLUMNS.map((name) => column("affiliates", name)),
    ", ",
  );
  const sellerCondition =
    post.row.seller_id === null
      ? Prisma.sql`${column("affiliates", "seller_id")} IS NULL`
      : Prisma.sql`${column("affiliates", "seller_id")} = ${post.row.seller_id}`;
  const rows = await selectRows(
    Prisma.sql`SELECT ${columns} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = ${"DirectAffiliate"} AND ${column("affiliates", "deleted_at")} IS NULL AND ${columnIn("affiliates", "id", ids)} AND ${sellerCondition} AND ${column("affiliates", "affiliate_user_id")} = ${affiliateUserId}`,
  );
  let affiliates = rows
    .map((row) => castRow<AffiliateRow & Record<string, unknown>>("Affiliate", row))
    .filter((affiliate) => (affiliate.flags & 2) !== 0);
  affiliates = affiliates.filter((affiliate) => createdWithinDates(filters, affiliate.created_at));
  if (match.affiliate_id !== null && match.affiliate_id !== undefined)
    affiliates = affiliates.filter((affiliate) => affiliate.id === match.affiliate_id);
  if (affiliates.length === 0) return [];
  const productIds = filters.affiliate_product_ids ?? [];
  const productCondition =
    productIds.length > 0 ? Prisma.sql` AND ${columnIn("affiliates_links", "link_id", productIds)}` : Prisma.empty;
  const times = await selectRows<{ created_at: Date }>(
    Prisma.sql`SELECT ${column("affiliates_links", "created_at")} FROM ${table("affiliates_links")} WHERE ${columnIn(
      "affiliates_links",
      "affiliate_id",
      affiliates.map((affiliate) => affiliate.id),
    )}${productCondition} AND ${column("affiliates_links", "created_at")} IS NOT NULL`,
  );
  return times.map((row) => new Date(Math.floor(new Date(row.created_at).getTime() / SECOND_MS) * SECOND_MS));
}

// `current_recipient_reference_time(installment:, purchase_id:, ...)`: the time the recipient's delay counts from today.
export async function currentRecipientReferenceTime(
  post: InstallmentPost,
  ids: RecipientIds,
  deps: RescheduleDeps,
): Promise<string | null> {
  if (!exactlyOne(ids)) return null;
  let reference: Date | null = null;
  if (present(ids.purchaseId)) {
    const original = await originalPurchaseOf(ids.purchaseId, deps);
    if (original !== null)
      reference = await workflowDeliveryReferenceTime(
        post,
        original.sale,
        await subscriptionOf(original.sale, original.subscription, deps),
      );
  } else if (present(ids.followerId)) {
    const [row] = await selectRows<{ confirmed_at: Date }>(
      Prisma.sql`SELECT ${column("followers", "confirmed_at")} FROM ${table("followers")} WHERE ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "confirmed_at")} IS NOT NULL AND ${column("followers", "id")} = ${recordIdFrom(ids.followerId, "Follower.where")} AND ${column("followers", "followed_id")} = ${post.row.seller_id} LIMIT 1`,
    );
    reference = row === undefined ? null : new Date(row.confirmed_at);
  } else if (present(ids.affiliateUserId)) {
    const userId = recordIdFrom(ids.affiliateUserId, "User.where");
    const [user] = await selectRows<{ email: string | null }>(
      Prisma.sql`SELECT ${column("users", "email")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
    );
    const filters = await audienceMembersFilterParams(post);
    const audience = await currentAudienceMemberAndMatch(post, user?.email ?? null, withoutDates(filters));
    if (audience !== null) {
      const times = await affiliateReferenceTimes(post, audience.member, audience.match, userId);
      reference = times.length === 0 ? null : new Date(Math.max(...times.map((time) => time.getTime())));
    }
  } else {
    const [row] = await selectRows<{ deactivated_at: Date | null }>(
      Prisma.sql`SELECT ${column("subscriptions", "deactivated_at")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${recordIdFrom(ids.subscriptionId, "Subscription.where")} LIMIT 1`,
    );
    reference = row?.deactivated_at ? new Date(row.deactivated_at) : null;
  }
  return reference === null ? null : iso8601(reference);
}

// `recipient_matches_current_audience?(installment:, purchase_id:, ..., reschedule_reference_time:)`
export async function recipientMatchesCurrentAudience(
  post: InstallmentPost,
  ids: RecipientIds,
  referenceTimeText: string,
  deps: RescheduleDeps,
): Promise<boolean> {
  if (!exactlyOne(ids)) return false;
  const reference = parseReferenceTime(referenceTimeText);
  if (post.flag("is_for_new_customers_of_workflow")) {
    if (post.row.published_at === null) throw nilReceiver("<=>");
    if (reference.getTime() < post.row.published_at.getTime()) return false;
  }

  if (present(ids.subscriptionId)) {
    const row = await findOneBy<Subscription>(
      "Subscription",
      "id",
      recordIdFrom(ids.subscriptionId, "Subscription.find_by"),
      true,
    );
    if (row === null) return false;
    const subscription = new SubscriptionRecord(row, deps.subscriptionDeps);
    // cancelled?: no longer alive, and a cancellation was recorded
    if (subscription.alive() || row.cancelled_at === null) return false;
    const sale = await subscription.originalPurchase();
    if (sale === null || row.deactivated_at === null) return false;
    if (await sentPostEmailExists(post, sale.email)) return false;
    const workflow = await post.workflow();
    if (workflow !== null && !(await workflow.appliesToPurchase(new PurchaseRecord(sale, subscription)))) return false;
    return wholeSeconds(row.deactivated_at) === wholeSeconds(reference);
  }

  if (present(ids.followerId)) {
    const follower = await activeFollower(post, ids.followerId);
    if (follower === null || follower.confirmed_at === null) return false;
    if (await sentPostEmailExists(post, follower.email)) return false;
    const filters = await audienceMembersFilterParams(post);
    const audience = await currentAudienceMemberAndMatch(post, follower.email, withoutDates(filters));
    if (audience === null) return false;
    const currentFollowerId = audience.match.follower_id ?? detailsOf(audience.member).follower?.id ?? null;
    if (currentFollowerId !== follower.id) return false;
    if (!createdWithinDates(filters, follower.created_at)) return false;
    return wholeSeconds(follower.confirmed_at) === wholeSeconds(reference);
  }

  if (present(ids.affiliateUserId)) {
    const userId = recordIdFrom(ids.affiliateUserId, "User.where");
    const [user] = await selectRows<{ email: string | null }>(
      Prisma.sql`SELECT ${column("users", "email")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
    );
    const email = user?.email ?? null;
    if (email === null || (await sentPostEmailExists(post, email))) return false;
    const filters = await audienceMembersFilterParams(post);
    const audience = await currentAudienceMemberAndMatch(post, email, withoutDates(filters));
    if (audience === null) return false;
    const times = await affiliateReferenceTimes(post, audience.member, audience.match, userId);
    return times.some((time) => time.getTime() === reference.getTime()) && reference.getTime() <= deps.now().getTime();
  }

  const original = await originalPurchaseOf(ids.purchaseId, deps);
  if (original === null) return false;
  const { sale } = original;
  if (await sentPostEmailExists(post, sale.email)) return false;
  const audience = await currentAudienceMemberAndMatch(post, sale.email, null);
  if (audience === null) return false;
  const current = (detailsOf(audience.member).purchases ?? []).some((purchase) => purchase.id === Number(sale.id));
  const workflow = await post.workflow();
  if (!current) return false;
  if (workflow === null) throw nilReceiver("applies_to_purchase?");
  const subscription = await subscriptionOf(sale, original.subscription, deps);
  if (!(await workflow.appliesToPurchase(new PurchaseRecord(sale, subscription)))) return false;
  if (sale.created_at === null) throw nilReceiver("change");
  const delivery = await workflowDeliveryReferenceTime(post, sale, subscription);
  return [sale.created_at, delivery].some((time) => wholeSeconds(time) === wholeSeconds(reference));
}

// `Follower.active.find_by(id:, followed_id: installment.seller_id)`
async function activeFollower(post: InstallmentPost, followerId: JsonValue | undefined): Promise<Follower | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`followers`.*")} FROM ${table("followers")} WHERE ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "confirmed_at")} IS NOT NULL AND ${column("followers", "id")} = ${recordIdFrom(followerId, "Follower.find_by")} AND ${column("followers", "followed_id")} = ${post.row.seller_id} LIMIT 1`,
  );
  return row === undefined ? null : castRow<Follower>("Follower", row);
}

// `reschedule_with_current_rule(...)`
export async function rescheduleWithCurrentRule(
  post: InstallmentPost,
  rule: InstallmentRule,
  version: number,
  ids: RecipientIds,
  referenceTimeText: string | null,
): Promise<void> {
  if (referenceTimeText === null || rule.version < version) return;
  if (rule.delayed_delivery_time === null)
    throw new NotPortedError("an installment rule without a delay", "installment_rule.rb");
  const deliverAt = new Date(parseReferenceTime(referenceTimeText).getTime() + rule.delayed_delivery_time * SECOND_MS);
  const jid = await performAsync(
    RESCHEDULE_JOB,
    [
      post.id,
      rule.version,
      ids.purchaseId ?? null,
      ids.followerId ?? null,
      ids.affiliateUserId ?? null,
      ids.subscriptionId ?? null,
      referenceTimeText,
    ],
    { at: deliverAt },
  );
  if (!jid) throw new FanoutNotEnqueuedError("Sidekiq did not enqueue the workflow installment");
}
