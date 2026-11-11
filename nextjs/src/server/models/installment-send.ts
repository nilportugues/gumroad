// Port of Installment#send_installment_from_workflow_for_{purchase,member_cancellation,follower,
// affiliate_user} and Installment#send_email (app/models/installment.rb), with SentPostEmail.ensure_uniqueness.
// Golden: worker/jobs/__fixtures__/post-email-sends.golden.json (scripts/golden/post-email-sends.rb).
//
// Every refusal after the claim (SentPostEmail row) is committed undoes the claim, as Ruby does when a
// handoff is refused, and hands the job back to Rails: the post has files (UrlRedirect), is a
// follower or audience post of a seller in the newsletter cutover, or post-email-api.ts and the post
// template do not cover it.
import {
  Prisma,
  type Follower,
  type InstallmentRule,
  type Purchase,
  type Subscription,
  type User,
} from "@prisma/client";

import { HandBackToRuby } from "../jobs/hand-back.ts";
import { PostEmailNotPortedError } from "../mail/post-email-template.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { InstallmentPost } from "./installment-post.ts";
import { LockUnavailable, processPostEmail, type PostEmailDeps, type Recipient } from "./post-email-api.ts";
import { PurchaseRecord } from "./purchase-pricing.ts";
import { isChargedbackNotReversedOrRefunded } from "./purchase.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import { connectedTo, uncached } from "./runtime/query-cache.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, execute, isRecordNotUnique, selectRows, table } from "./sql.ts";
import { SubscriptionRecord, defaultSubscriptionDeps, type SubscriptionDeps } from "./subscription.ts";
import { SEND_WORKFLOW_INSTALLMENT_WORKER } from "./workflow-scheduling.ts";
import type { WorkflowRecord } from "./workflow.ts";

type Rule = InstallmentRule;

// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];
// The seed of the official newsletter seller (Onetime::MigrateNewsletterSubscribersToFeatureAnnouncements)
const NEWSLETTER_SELLER_EXTERNAL_ID = "6282492303727";
const CHARGEBACK_REVERSED_FLAG = 512;
const MINUTE_MS = 60_000;
const SEND_WORKFLOW_INSTALLMENT_RESCHEDULE_JOB = "SendWorkflowInstallmentRescheduleJob";

export type SendDeps = PostEmailDeps & { subscriptionDeps: SubscriptionDeps };

export const defaultSendDeps = (base: PostEmailDeps): SendDeps => ({
  ...base,
  subscriptionDeps: { now: base.now, featureActive: defaultSubscriptionDeps.featureActive },
});

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && !/^[\t\n\v\f\r ]*$/u.test(value);

// ----- FeatureAnnouncementNewsletterCutover

export async function retiredFor(sellerId: number | null): Promise<boolean> {
  return connectedTo("writing", () =>
    uncached(async () => {
      const rows = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("feature_announcement_newsletter_cutovers")} WHERE ${column("feature_announcement_newsletter_cutovers", "seller_id")} = ${sellerId} AND ${column("feature_announcement_newsletter_cutovers", "state")} = ${"retired"} LIMIT 1`,
      );
      return rows.length > 0;
    }),
  );
}

// `handoff_admission_for(post)` is nil unless the post goes to followers or the audience of a seller with a
// cutover (or the official newsletter seller): those hand off under the cutover's barrier lock.
async function needsNewsletterAdmission(post: InstallmentPost): Promise<boolean> {
  if (!post.audienceType && !post.followerType) return false;
  const sellerId = post.row.seller_id;
  if (sellerId === null) return false;
  return connectedTo("writing", () =>
    uncached(async () => {
      const [official] = await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${NEWSLETTER_SELLER_EXTERNAL_ID} LIMIT 1`,
      );
      if (official !== undefined && BigInt(sellerId) === BigInt(official.id)) return true;
      const rows = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("feature_announcement_newsletter_cutovers")} WHERE ${column("feature_announcement_newsletter_cutovers", "seller_id")} = ${sellerId} LIMIT 1`,
      );
      return rows.length > 0;
    }),
  );
}

// ----- SentPostEmail

// `SentPostEmail.ensure_uniqueness(post:, email:, source:)`: the claim is written only while the row it was read
// from still holds the address, under a share lock; a claim somebody else holds skips the send.
export async function ensureUniqueness(
  post: InstallmentPost,
  email: string | null,
  source: { table: string; id: bigint | number },
  deps: SendDeps,
  send: () => Promise<void>,
): Promise<void> {
  if (!present(email)) return;
  let claimed: boolean;
  try {
    claimed = await connectedTo("writing", () =>
      transaction(async () => {
        const [row] = await selectRows<{ email: string | null }>(
          Prisma.sql`SELECT ${column(source.table, "email")} FROM ${table(source.table)} WHERE ${column(source.table, "id")} = ${source.id} LIMIT 1 FOR SHARE`,
        );
        if (row?.email !== email) return false;
        // before_validation :downcase_email
        const now = deps.now();
        await execute(
          Prisma.sql`INSERT INTO ${table("sent_post_emails")} (${Prisma.raw("`post_id`, `email`, `created_at`, `updated_at`")}) VALUES (${post.id}, ${email.toLowerCase()}, ${now}, ${now})`,
        );
        return true;
      }),
    );
  } catch (error) {
    if (isRecordNotUnique(error)) return;
    throw error;
  }
  if (!claimed) {
    deps.log(`SentPostEmail: skipped post ${post.id} for ${source.table} ${String(source.id)}, whose address changed`);
    return;
  }
  await send();
}

// `SentPostEmail.where(post_id: id, email:).delete_all`
async function deleteClaim(post: InstallmentPost, email: string): Promise<void> {
  await execute(
    Prisma.sql`DELETE FROM ${table("sent_post_emails")} WHERE ${column("sent_post_emails", "post_id")} = ${post.id} AND ${column("sent_post_emails", "email")} = ${email}`,
  );
}

// ----- send_email

async function sendEmail(post: InstallmentPost, recipient: Recipient, deps: SendDeps): Promise<void> {
  try {
    if (await needsNewsletterAdmission(post))
      throw new PostEmailNotPortedError("a newsletter post of a seller in the feature announcement cutover");
    await processPostEmail(
      {
        post,
        recipients: [recipient],
        // A follow that ended after the worker checked it is withheld at the handoff, which isn't a send either.
        onWithheld: recipient.follower === undefined ? undefined : async () => deleteClaim(post, recipient.email),
      },
      deps,
    );
  } catch (error) {
    if (error instanceof LockUnavailable) {
      // Refused before the provider saw it, so the claim isn't a send.
      await deleteClaim(post, recipient.email);
      throw error;
    }
    if (error instanceof PostEmailNotPortedError) {
      await deleteClaim(post, recipient.email);
      throw new HandBackToRuby(error.message);
    }
    throw error;
  }
}

// `PostEmailApi.process(post:, recipients: [recipient])` called directly (SendLastPostJob): no cache, no newsletter admission.
export async function sendPostEmailDirect(post: InstallmentPost, recipient: Recipient, deps: SendDeps): Promise<void> {
  try {
    await processPostEmail({ post, recipients: [recipient] }, deps);
  } catch (error) {
    if (error instanceof PostEmailNotPortedError) {
      await deleteClaim(post, recipient.email);
      throw new HandBackToRuby(error.message);
    }
    throw error;
  }
}

// `generate_url_redirect_for_*(...) if has_files?`: Node does not create UrlRedirects.
export async function refuseFiles(post: InstallmentPost, recipient: Recipient): Promise<void> {
  if (!(await post.hasFiles())) return;
  await deleteClaim(post, recipient.email);
  throw new HandBackToRuby("a post with files (UrlRedirect)");
}

// ----- the purchase side

// Purchase::ALL_SUCCESS_STATES, not_fully_refunded, not_chargedback_or_chargedback_reversed and the subscription scope,
// from the email_infos of this post (`already_emailed_workflow_purchase?`).
async function alreadyEmailed(
  post: InstallmentPost,
  sale: Purchase,
  scope: "no_or_active_subscription" | "inactive_subscription",
): Promise<boolean> {
  const emailCondition =
    sale.email === null
      ? Prisma.sql`${column("purchases", "email")} IS NULL`
      : Prisma.sql`${column("purchases", "email")} = ${sale.email}`;
  const states = Prisma.join(ALL_SUCCESS_STATES, ", ");
  const subscriptionCondition =
    scope === "no_or_active_subscription"
      ? Prisma.raw("(subscriptions.deactivated_at IS NULL)")
      : Prisma.raw("(subscriptions.deactivated_at IS NOT NULL)");
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("email_infos")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("email_infos", "purchase_id")} LEFT OUTER JOIN subscriptions ON subscriptions.id = purchases.subscription_id WHERE ${column("email_infos", "type")} = ${"CreatorContactingCustomersEmailInfo"} AND ${column("email_infos", "installment_id")} = ${post.id} AND ${emailCondition} AND ${column("purchases", "seller_id")} = ${sale.seller_id} AND ${column("purchases", "purchase_state")} IN (${states}) AND ${subscriptionCondition} AND ${Prisma.raw("(purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)")} AND ${Prisma.raw(`(purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '${CHARGEBACK_REVERSED_FLAG}' != 0))`)} LIMIT 1`,
  );
  return rows.length > 0;
}

// Subscription events: the latest of a type, as `subscription_events.restarted.order(occurred_at: :desc).take`.
async function latestEventAt(subscriptionId: bigint, eventType: number): Promise<Date | null> {
  const [row] = await selectRows<{ occurred_at: Date }>(
    Prisma.sql`SELECT ${Prisma.raw("`subscription_events`.*")} FROM ${table("subscription_events")} WHERE ${column("subscription_events", "subscription_id")} = ${subscriptionId} AND ${column("subscription_events", "event_type")} = ${eventType} ORDER BY ${column("subscription_events", "occurred_at")} DESC LIMIT 1`,
  );
  return row === undefined ? null : new Date(row.occurred_at);
}

// `workflow_delivery_reference_time(sale)`: the purchase time, moved by the time a membership was lapsed.
export async function workflowDeliveryReferenceTime(
  post: InstallmentPost,
  sale: Purchase,
  subscription: SubscriptionRecord | null,
): Promise<Date> {
  if (sale.created_at === null) throw new TypeError("undefined method 'created_at' for nil");
  const workflow = await post.workflow();
  if (workflow !== null && subscription !== null) {
    const restarted = await latestEventAt(subscription.id, 1);
    // last_deactivated_at: the subscription's own column, else its latest deactivated event
    const deactivated =
      restarted === null ? null : (subscription.row.deactivated_at ?? (await latestEventAt(subscription.id, 0)));
    if (restarted !== null && deactivated !== null)
      return new Date(sale.created_at.getTime() + (restarted.getTime() - deactivated.getTime()));
  }
  return sale.created_at;
}

// `expected_delivery_time(sale)`: the reference time plus the rule's delay.
async function expectedDeliveryTime(
  post: InstallmentPost,
  rule: Rule | null,
  sale: Purchase,
  subscription: SubscriptionRecord | null,
): Promise<Date> {
  if (sale.created_at === null) throw new TypeError("undefined method 'created_at' for nil");
  if (rule === null) return sale.created_at;
  if (rule.delayed_delivery_time === null) throw new TypeError("nil can't be coerced into Integer");
  const reference = await workflowDeliveryReferenceTime(post, sale, subscription);
  return new Date(reference.getTime() + rule.delayed_delivery_time * 1000);
}

function purchaseRecord(row: Purchase, owner: SubscriptionRecord | null): PurchaseRecord {
  return new PurchaseRecord(row, owner);
}

async function appliesToPurchase(workflow: WorkflowRecord | null, sale: PurchaseRecord): Promise<boolean> {
  return workflow === null || (await workflow.appliesToPurchase(sale));
}

export async function sendInstallmentFromWorkflowForPurchase(
  post: InstallmentPost,
  purchaseId: bigint,
  rescheduleReferenceTime: string | null,
  deps: SendDeps,
): Promise<void> {
  const loaded = await findById<Purchase>("Purchase", purchaseId);
  if (loaded === null) throw new RecordNotFound(`Couldn't find Purchase with 'id'=${String(purchaseId)}`);
  let subscription: SubscriptionRecord | null = null;
  if (loaded.subscription_id !== null) {
    const row = await findById<Subscription>("Subscription", loaded.subscription_id);
    if (row !== null) subscription = new SubscriptionRecord(row, deps.subscriptionDeps);
  }
  // is_recurring_subscription_charge
  if (
    subscription !== null &&
    !PurchaseFlags.isSet(loaded.flags, "is_original_subscription_purchase") &&
    !PurchaseFlags.isSet(loaded.flags, "is_gift_receiver_purchase")
  )
    return;
  if (await post.memberCancellationTrigger()) return;

  let sale = loaded;
  if (loaded.subscription_id !== null) {
    if (subscription === null) throw new TypeError("undefined method 'original_purchase' for nil");
    const original = await subscription.originalPurchase();
    if (original === null) throw new TypeError("undefined method 'can_contact?' for nil");
    sale = original;
  }
  if (sale.can_contact !== true) return;
  if (isChargedbackNotReversedOrRefunded(sale)) return;
  if (subscription !== null && !subscription.alive()) return;
  if (await alreadyEmailed(post, sale, "no_or_active_subscription")) return;

  const workflow = await post.workflow();
  const saleRecord = purchaseRecord(sale, subscription);
  if (!(await appliesToPurchase(workflow, saleRecord))) return;
  const rule = await post.installmentRule();
  const expected = await expectedDeliveryTime(post, rule, sale, subscription);
  if (deps.now().getTime() < expected.getTime()) {
    // Too soon (a membership that was ended and restarted): try again a minute after it is due.
    const args: (number | bigint | null | string)[] = [post.id, rule!.version, Number(sale.id), null];
    const rescheduling = present(rescheduleReferenceTime);
    if (rescheduling) args.push(null, null, rescheduleReferenceTime);
    await performAsync(
      rescheduling ? SEND_WORKFLOW_INSTALLMENT_RESCHEDULE_JOB : SEND_WORKFLOW_INSTALLMENT_WORKER,
      args as never,
      { at: new Date(expected.getTime() + MINUTE_MS) },
    );
    return;
  }
  await ensureUniqueness(post, sale.email, { table: "purchases", id: sale.id }, deps, async () => {
    const recipient: Recipient = { email: sale.email!, purchase: sale };
    await refuseFiles(post, recipient);
    await sendEmail(post, recipient, deps);
  });
}

export async function sendInstallmentFromWorkflowForMemberCancellation(
  post: InstallmentPost,
  subscriptionId: bigint,
  deps: SendDeps,
): Promise<void> {
  if (!(await post.memberCancellationTrigger())) return;
  const row = await findById<Subscription>("Subscription", subscriptionId);
  if (row === null) throw new RecordNotFound(`Couldn't find Subscription with 'id'=${String(subscriptionId)}`);
  const subscription = new SubscriptionRecord(row, deps.subscriptionDeps);
  if (subscription.alive()) return;
  const sale = await subscription.originalPurchase();
  if (sale === null) return;
  if (sale.can_contact !== true) return;
  if (isChargedbackNotReversedOrRefunded(sale)) return;
  if (await alreadyEmailed(post, sale, "inactive_subscription")) return;
  if (!(await appliesToPurchase(await post.workflow(), purchaseRecord(sale, subscription)))) return;
  await ensureUniqueness(post, sale.email, { table: "purchases", id: sale.id }, deps, async () => {
    const recipient: Recipient = { email: sale.email!, purchase: sale, subscription: { id: subscription.id } };
    await refuseFiles(post, recipient);
    await sendEmail(post, recipient, deps);
  });
}

export async function sendInstallmentFromWorkflowForFollower(
  post: InstallmentPost,
  followerId: number,
  deps: SendDeps,
): Promise<void> {
  const follower = await findOneBy<Follower>("Follower", "id", followerId, true);
  // Followers removed as duplicates may still be queued; an unconfirmed or deleted one is not a recipient.
  if (follower === null || follower.deleted_at !== null || follower.confirmed_at === null) return;
  await ensureUniqueness(post, follower.email, { table: "followers", id: follower.id }, deps, async () => {
    const recipient: Recipient = { email: follower.email!, follower };
    await refuseFiles(post, recipient);
    await sendEmail(post, recipient, deps);
  });
}

export async function sendInstallmentFromWorkflowForAffiliateUser(
  post: InstallmentPost,
  affiliateUserId: bigint,
  deps: SendDeps,
): Promise<void> {
  const user = await findById<User>("User", affiliateUserId);
  if (user === null) return;
  await ensureUniqueness(post, user.email, { table: "users", id: user.id }, deps, async () => {
    const recipient: Recipient = { email: user.email!, affiliate: user };
    await refuseFiles(post, recipient);
    await sendEmail(post, recipient, deps);
  });
}
