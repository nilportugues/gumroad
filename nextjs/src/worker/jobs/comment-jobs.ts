// Ports of the jobs whose only model write is a Comment:
// app/sidekiq/content_moderation_admin_comment_job.rb,
// app/sidekiq/release_chargeback_rate_payout_pauses_job.rb and
// app/sidekiq/detect_legal_entity_country_drift_job.rb.
import { Prisma } from "@prisma/client";

import {
  alive,
  COMMENT_TYPES,
  COMMENTS,
  commentsOf,
  Comments,
  CONTENT_MODERATION_ADMIN_COMMENT_DEDUP_WINDOW,
  CONTENT_MODERATION_AUTHOR_NAME,
  withType,
} from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { STRIPE_CHARGE_PROCESSOR_ID, stripeAccountOf, stripeConnectMeta } from "../../server/models/merchant-account.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { modelJob } from "./support/job-deps.ts";

// User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:high_chargeback_rate] (app/modules/user/risk.rb).
export const HIGH_CHARGEBACK_RATE_PAUSE_AUTHOR = "pause_payouts_for_seller_based_on_chargeback_rate";
const RELEASE_BATCH_SIZE = 1_000;

export const contentModerationAdminCommentJobWith = modelJob({ min: 2 }, async ([userId, content], deps) => {
  const [user] = await selectRows<{ id: unknown }>(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
  if (!user) return;

  // A seller retrying a blocked publish re-triggers the moderation check.
  const since = ago(CONTENT_MODERATION_ADMIN_COMMENT_DEDUP_WINDOW, deps.now());
  const duplicates = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(COMMENTS)} WHERE ${commentsOf("User", user.id)} AND ${withType(COMMENT_TYPES.NOTE)} AND ${column(COMMENTS, "author_name")} = ${CONTENT_MODERATION_AUTHOR_NAME} AND ${column(COMMENTS, "content")} = ${content} AND (created_at > ${since}) LIMIT 1`,
  );
  if (duplicates.length > 0) return;

  await Comments.createBang(
    { commentable_id: user.id as bigint, commentable_type: "User", author_name: CONTENT_MODERATION_AUTHOR_NAME, comment_type: COMMENT_TYPES.NOTE, content: content as string },
    { now: deps.now },
  );
});

// `find_in_batches` over `select(:id, :commentable_id)`.
export const releaseChargebackRatePayoutPausesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const seen = new Set<string>();
  const where = Prisma.sql`${alive} AND ${withType(COMMENT_TYPES.ON_PROBATION)} AND ${column(COMMENTS, "commentable_type")} = ${"User"} AND ${column(COMMENTS, "author_name")} = ${HIGH_CHARGEBACK_RATE_PAUSE_AUTHOR}`;
  let after: unknown = null;
  for (;;) {
    const rows = await selectRows<{ id: unknown; commentable_id: bigint | number }>(
      Prisma.sql`SELECT ${column(COMMENTS, "id")}, ${column(COMMENTS, "commentable_id")} FROM ${table(COMMENTS)} WHERE ${where}${
        after === null ? Prisma.empty : Prisma.sql` AND ${column(COMMENTS, "id")} > ${after}`
      } ORDER BY ${column(COMMENTS, "id")} ASC LIMIT ${Prisma.raw(String(RELEASE_BATCH_SIZE))}`,
    );
    if (rows.length === 0) return;
    await deps.watchReplicaLag();
    for (const row of rows) {
      const key = String(row.commentable_id);
      if (seen.has(key)) continue;
      seen.add(key);
      await performAsync("ReleaseChargebackRatePayoutPauseForSellerJob", [row.commentable_id]);
    }
    if (rows.length < RELEASE_BATCH_SIZE) return;
    after = rows.at(-1)!.id;
  }
});

export const LEGAL_ENTITY_COUNTRY_DRIFT_AUTHOR = "legal-entity-country-drift";
const LEGAL_ENTITY_COUNTRY_DRIFT_DEDUP_WINDOW = { days: 30 } as const;
// String#blank? (/\A[[:space:]]*\z/) for the string columns this job reads.
const blank = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "");

type ComplianceInfoRow = { user_id: unknown; country_code: unknown; business_country_code: unknown; is_business: unknown };

export const detectLegalEntityCountryDriftJobWith = modelJob({ min: 1 }, async ([complianceInfoId], deps) => {
  const [info] = await selectRows<ComplianceInfoRow>(
    Prisma.sql`SELECT ${Prisma.raw("`user_compliance_info`.*")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "id")} = ${complianceInfoId} LIMIT 1`,
  );
  if (!info || info.user_id == null) return;
  const userSql = (lock: boolean) =>
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${info.user_id} LIMIT 1${lock ? Prisma.raw(" FOR UPDATE") : Prisma.empty}`;
  const [user] = await selectRows<{ id: unknown }>(userSql(false));
  if (!user) return;

  // `(business_country_code if is_business?) || country_code`, where Ruby's "" is truthy.
  const isBusiness = info.is_business != null && info.is_business !== false && Number(info.is_business) !== 0;
  const derivedCountry = isBusiness && info.business_country_code != null ? info.business_country_code : info.country_code;
  if (blank(derivedCountry)) return;

  const account = await stripeAccountOf(user.id);
  if (!account) return;
  if (!(account.charge_processor_id === STRIPE_CHARGE_PROCESSOR_ID && stripeConnectMeta(account.json_data) !== "true")) return;

  const accountCountry = account.country;
  if (blank(accountCountry) || accountCountry === derivedCountry) return;

  const content =
    `Legal-entity country ${String(derivedCountry)} does not match the Stripe account country ${String(accountCountry)} (${String(account.charge_processor_merchant_id ?? "")}). ` +
    "Compliance resync to Stripe will fail for this seller until the account is recreated in the correct country; Stripe cannot change an existing account's country.";

  // user.with_lock: lock! reloads the row FOR UPDATE inside the transaction.
  await transaction(async () => {
    const [locked] = await selectRows(userSql(true));
    if (!locked) throw new Error(`Couldn't find User with 'id'=${String(user.id)}`);
    const since = ago(LEGAL_ENTITY_COUNTRY_DRIFT_DEDUP_WINDOW, deps.now());
    const duplicates = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table(COMMENTS)} WHERE ${commentsOf("User", user.id)} AND ${withType(COMMENT_TYPES.NOTE)} AND ${column(COMMENTS, "author_name")} = ${LEGAL_ENTITY_COUNTRY_DRIFT_AUTHOR} AND ${column(COMMENTS, "content")} = ${content} AND (created_at > ${since}) LIMIT 1`,
    );
    if (duplicates.length > 0) return;
    await Comments.createBang(
      { commentable_id: BigInt(user.id as bigint), commentable_type: "User", author_name: LEGAL_ENTITY_COUNTRY_DRIFT_AUTHOR, comment_type: COMMENT_TYPES.NOTE, content },
      { now: deps.now },
    );
  });
});

export const contentModerationAdminCommentJob = contentModerationAdminCommentJobWith();
export const releaseChargebackRatePayoutPausesJob = releaseChargebackRatePayoutPausesJobWith();
export const detectLegalEntityCountryDriftJob = detectLegalEntityCountryDriftJobWith();
