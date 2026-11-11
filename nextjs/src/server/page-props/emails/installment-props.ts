// InstallmentPresenter#props for a post (an installment outside a workflow): the attributes of
// audience/installments.ts plus the profile, blast and resend state.
import { Prisma, type Installment, type InstallmentRule, type User } from "@prisma/client";

import { isFeatureEnabled } from "../../infra/flipper.ts";
import { getRedis } from "../../infra/redis.ts";
import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { parseJsonData, filterValue } from "../../models/with-filtering.ts";
import { installmentBaseProps, flagSet, type InstallmentContext } from "../audience/installments.ts";
import { externalId, userSubdomainWithProtocol, userUsername } from "../audience/support.ts";
import { NotPortedError } from "../not-ported.ts";

const FLAG_SHOWN_ON_PROFILE = 2 ** 7;
const FLAG_READY_TO_PUBLISH = 2 ** 9;
const RECIPIENT_FILTER_UNOPENED = "unopened";
const EXPIRY_ABANDONED = "abandoned";
const EXPIRY_NEWSLETTER_RETIRED = "newsletter_retired";

// AlertOnStalledPostEmailBlastsJob
const EMAIL_ACTIVITY_THRESHOLD_MS = 30 * 60_000;
const LOOKBACK_MS = 14 * 24 * 3_600_000;
const SCAN_INTERVAL_MS = 6 * 3_600_000;
const AUTO_RESUME_WINDOW_MS = 24 * 3_600_000;
const AUTO_RESUME_FEATURE = "auto_resume_stalled_post_blasts";

export type Blast = {
  id: number;
  requested_at: Date | null;
  first_email_delivered_at: Date | null;
  last_email_delivered_at: Date | null;
  delivery_count: number | null;
  completed_at: Date | null;
  recipient_filter: string | null;
  expired_at: Date | null;
  expiry_reason: string | null;
};

export type PostContext = InstallmentContext & {
  blasts: Blast[];
  // The seller's posts sections: external id and the ids of the posts each shows.
  sections: { externalId: string; shownPosts: number[] }[];
  linkName: string | null;
  variantName: string | null;
};

const toISO = (value: Date | null) => (value ? value.toISOString() : null);

async function redisInt(key: string): Promise<number | null> {
  const value = await getRedis("main").get(key);
  return value === null || value.trim() === "" ? null : Number.parseInt(value, 10) || 0;
}

async function quotaDeferredUntil(blastId: number): Promise<Date | null> {
  const value = await getRedis("main").get(`blast:${blastId}:quota_deferred_until`);
  if (value === null || value.trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new NotPortedError("a quota_deferred_until that Time.zone.parse reads differently");
  return parsed;
}

// PostEmailBlast#delivery_status
async function deliveryStatus(blast: Blast, remaining: number | null, now: number): Promise<string> {
  if (blast.completed_at) return "sent";
  if (blast.expired_at && blast.expiry_reason === EXPIRY_NEWSLETTER_RETIRED) return "stopped";
  if (remaining !== null && remaining <= 0) return "sent";
  if (blast.expired_at) return blast.expiry_reason === EXPIRY_ABANDONED ? "abandoned" : "expired";
  const deferred = await quotaDeferredUntil(blast.id);
  if (deferred && deferred.getTime() > now) return "waiting";
  const activity = Math.max(
    ...[blast.requested_at, blast.last_email_delivered_at]
      .filter((time): time is Date => time !== null)
      .map((time) => time.getTime()),
  );
  if (activity > now - EMAIL_ACTIVITY_THRESHOLD_MS) return "sending";
  return "incomplete";
}

// AlertOnStalledPostEmailBlastsJob.auto_resume_eligible?
async function autoResumeEligible(blast: Blast, remaining: number | null, now: number): Promise<boolean> {
  if (!(await isFeatureEnabled(AUTO_RESUME_FEATURE))) return false;
  if (
    blast.completed_at ||
    blast.expired_at ||
    !blast.requested_at ||
    blast.recipient_filter === RECIPIENT_FILTER_UNOPENED
  )
    return false;
  const requested = blast.requested_at.getTime();
  if (!(requested > now - (LOOKBACK_MS - 2 * SCAN_INTERVAL_MS))) return false;
  return requested > now - (AUTO_RESUME_WINDOW_MS - SCAN_INTERVAL_MS) || (remaining !== null && remaining > 0);
}

// InstallmentPresenter#delivery_props
async function deliveryProps(blasts: Blast[]): Promise<Record<string, unknown> | null> {
  const regular = blasts.filter((blast) => blast.recipient_filter !== RECIPIENT_FILTER_UNOPENED);
  const blast = regular.reduce<Blast | null>(
    (latest, candidate) =>
      latest === null || (candidate.requested_at?.getTime() ?? 0) > (latest.requested_at?.getTime() ?? 0)
        ? candidate
        : latest,
    null,
  );
  if (!blast || blast.requested_at === null) return null;
  const now = Date.now();
  const remaining = await redisInt(`blast:${blast.id}:pending_recipients`);
  const status = await deliveryStatus(blast, remaining, now);
  return {
    status,
    delivered_count: blast.delivery_count,
    remaining_count: status === "sent" ? null : remaining,
    scheduled_for: status === "waiting" ? toISO(await quotaDeferredUntil(blast.id)) : null,
    retrying: status === "incomplete" && (await autoResumeEligible(blast, remaining, now)),
  };
}

// InstallmentPresenter#resend_open_counts: first opens in each completed resend's window, in one grouped query.
async function resendOpenCounts(installmentId: number, resends: Blast[]): Promise<Map<number, number>> {
  const windows = resends.flatMap((blast, index) => {
    if (!blast.completed_at) return [];
    const next = resends.slice(index + 1).find((later) => later.completed_at);
    return [{ index, startsAt: blast.requested_at!, endsAt: next?.requested_at ?? null }];
  });
  const counts = new Map<number, number>();
  if (windows.length === 0) return counts;
  const whens = windows.map(({ index, startsAt, endsAt }) =>
    endsAt
      ? Prisma.sql`WHEN opened_at >= ${startsAt} AND opened_at < ${endsAt} THEN ${index}`
      : Prisma.sql`WHEN opened_at >= ${startsAt} THEN ${index}`,
  );
  const bucket = Prisma.sql`CASE ${Prisma.join(whens, " ")} END`;
  const rows = await selectRows<{ bucket: bigint | number | null; count: bigint | number }>(
    Prisma.sql`SELECT ${bucket} AS bucket, COUNT(*) AS count FROM ${table("email_infos")} WHERE ${column("email_infos", "installment_id")} = ${installmentId} AND ${column("email_infos", "state")} = 'opened' AND opened_at >= ${windows[0]!.startsAt} GROUP BY bucket`,
  );
  for (const row of rows) if (row.bucket !== null) counts.set(Number(row.bucket), Number(row.count));
  return counts;
}

// InstallmentPresenter#non_opener_resend_props
async function nonOpenerResendProps(installmentId: number, blasts: Blast[]) {
  const resends = blasts
    .filter((blast) => blast.recipient_filter === RECIPIENT_FILTER_UNOPENED)
    .sort((a, b) => a.requested_at!.getTime() - b.requested_at!.getTime());
  const counts = await resendOpenCounts(installmentId, resends);
  return resends.map((blast, index) => {
    const completed = blast.completed_at !== null;
    const openCount = completed ? (counts.get(index) ?? 0) : null;
    const delivered = blast.delivery_count ?? 0;
    const openRate =
      openCount !== null && delivered > 0
        ? rubyFloatRoundDigits(Math.min((openCount / delivered) * 100, 100), 1)
        : null;
    return {
      requested_at: toISO(blast.requested_at),
      delivery_count: blast.delivery_count,
      completed,
      expired: blast.expired_at !== null,
      open_count: openCount,
      open_rate: openRate,
    };
  });
}

// Installment#never_reached_anyone?
function neverReachedAnyone(blasts: Blast[]): boolean {
  const regular = blasts.filter((blast) => blast.recipient_filter !== RECIPIENT_FILTER_UNOPENED);
  return (
    regular.some((blast) => blast.expired_at) &&
    regular.every((blast) => !blast.completed_at && !blast.first_email_delivered_at)
  );
}

// Installment#full_url
export function fullUrl(seller: User, installment: Installment): string | null {
  if (installment.slug === null || installment.slug === "") return null;
  const host = userSubdomainWithProtocol(seller);
  if (host) return `${host}/p/${installment.slug}`;
  return `/${userUsername(seller) ?? externalId(seller.id)}/p/${installment.slug}`;
}

async function affiliateProductName(installment: Installment): Promise<string | null> {
  const permalinks = filterValue({ jsonData: () => parseJsonData(installment.json_data) }, "affiliate_products");
  if (!Array.isArray(permalinks) || permalinks.length !== 1) return null;
  const [row] = await selectRows<{ name: string }>(
    Prisma.sql`SELECT ${column("links", "name")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${String(permalinks[0])} LIMIT 1`,
  );
  return row?.name ?? null;
}

async function recipientDescription(installment: Installment, context: PostContext): Promise<string | null> {
  switch (installment.installment_type) {
    case "seller":
      return "Your customers";
    case "product":
      return `Customers of ${context.linkName}`;
    case "variant":
      return `Customers of ${context.linkName} - ${context.variantName}`;
    case "follower":
      return "Your followers";
    case "audience":
      return "Your customers and followers";
    case "affiliate": {
      const name = await affiliateProductName(installment);
      return name === null ? "Your affiliates" : `Affiliates of ${name}`;
    }
    default:
      return null;
  }
}

// InstallmentPresenter#props, for a post.
export async function postInstallmentProps(options: {
  seller: User;
  installment: Installment;
  context: PostContext;
  rule: InstallmentRule | null;
}): Promise<Record<string, unknown>> {
  const { seller, installment, context, rule } = options;
  const props = await installmentBaseProps({ seller, installment, context });
  const shown = flagSet(installment.flags, FLAG_SHOWN_ON_PROFILE);
  Object.assign(props, {
    view_count: shown ? installment.installment_events_count : null,
    full_url: fullUrl(seller, installment),
    has_been_blasted: context.blasts.length > 0,
    shown_in_profile_sections: context.sections
      .filter((section) => section.shownPosts.includes(installment.id))
      .map((section) => section.externalId),
    non_opener_resends: await nonOpenerResendProps(installment.id, context.blasts),
    delivery: await deliveryProps(context.blasts),
    never_reached_anyone: neverReachedAnyone(context.blasts),
  });
  if (installment.published_at === null) {
    props.recipient_description = await recipientDescription(installment, context);
    if (flagSet(installment.flags, FLAG_READY_TO_PUBLISH)) {
      if (!rule) throw new TypeError("undefined method 'to_be_published_at' for nil");
      props.to_be_published_at = toISO(rule.to_be_published_at);
    }
  }
  delete props.paid_more_than;
  delete props.paid_less_than;
  return props;
}
