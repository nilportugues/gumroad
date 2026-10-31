// Ports of scheduled jobs that read a table and enqueue or cache what they find:
//   app/sidekiq/recover_aus_backtaxes_from_stripe_accounts_job.rb
//   app/sidekiq/alert_on_stalled_abandoned_cart_emails_job.rb
//   app/sidekiq/build_tax_rate_cache_worker.rb
import { Prisma } from "@prisma/client";

import { getRedis, namespacedKey } from "../../server/infra/redis.ts";
import { BACKTAX_AGREEMENTS, BACKTAX_JURISDICTIONS, notCollectedScope } from "../../server/models/backtax-agreement.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { SENT_ABANDONED_CART_EMAILS } from "../../server/models/sent-abandoned-cart-email.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { ZIP_TAX_RATES } from "../../server/models/zip-tax-rate.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

export const recoverAusBacktaxesFromStripeAccountsJobWith = modelJob({ min: 0 }, async () => {
  const rows = await selectRows<{ user_id: bigint | number }>(
    Prisma.sql`SELECT ${column(BACKTAX_AGREEMENTS, "user_id")} FROM ${table(BACKTAX_AGREEMENTS)} WHERE ${notCollectedScope()} AND ${column(BACKTAX_AGREEMENTS, "jurisdiction")} = ${BACKTAX_JURISDICTIONS.AUSTRALIA}`,
  );
  const creatorIds = [...new Set(rows.map((row) => BigInt(row.user_id)))];
  for (const creatorId of creatorIds) await performAsync("RecoverAusBacktaxFromStripeAccountJob", [creatorId]);
});

// --- AlertOnStalledAbandonedCartEmailsJob -------------------------------------------------------

// The sender runs daily and writes its first rows within minutes, so a silent day is a failure.
const STALL_THRESHOLD = { hours: 24 };
const SECONDS_PER_HOUR = 3600;

function headline(lastSentAt: Date | null, now: Date): string {
  if (lastSentAt === null) return "No abandoned-cart email has ever been sent — sent_abandoned_cart_emails is empty.";
  const hours = Math.floor((now.getTime() - lastSentAt.getTime()) / 1000 / SECONDS_PER_HOUR);
  const at = lastSentAt.toISOString();
  return `No abandoned-cart email has been sent in ${hours} hours. The last one went out at ${at.slice(0, 10)} ${at.slice(11, 16)} UTC.`;
}

function messageFor(lastSentAt: Date | null, now: Date): string {
  return [
    headline(lastSentAt, now),
    "",
    "ScheduleAbandonedCartEmailsJob runs daily. A run that aborts partway still delivers the windows it finished, so total silence means it died before the first window's delivery, was never enqueued, or the schedule stopped firing — check the dead set and the cron's last_enqueue_time, not just Sentry.",
    "",
    "Carts stop being eligible once they age past Cart::ABANDONED_IF_UPDATED_AFTER_AGO, so every silent day permanently loses that day's carts. See gumroad-private#2343.",
  ].join("\n");
}

export const alertOnStalledAbandonedCartEmailsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  // Newest id rather than MAX(created_at), which has no index: rows are only inserted at delivery.
  const rows = await selectRows<{ created_at: Date | null }>(
    Prisma.sql`SELECT ${column(SENT_ABANDONED_CART_EMAILS, "created_at")} FROM ${table(SENT_ABANDONED_CART_EMAILS)} ORDER BY ${column(SENT_ABANDONED_CART_EMAILS, "id")} DESC LIMIT 1`,
  );
  const lastSentAt = rows[0]?.created_at ?? null;
  if (lastSentAt !== null && lastSentAt > ago(STALL_THRESHOLD, deps.now())) return;

  await performAsync("InternalNotificationWorker", ["agent_reports", "Abandoned cart emails stalled", messageFor(lastSentAt, deps.now())]);
});

// --- BuildTaxRateCacheWorker --------------------------------------------------------------------

// BigDecimal#to_s as ActiveSupport overrides it (format "F"): plain digits, always a fraction.
export function bigDecimalToS(value: Prisma.Decimal): string {
  const text = value.toFixed();
  return text.includes(".") ? text : `${text}.0`;
}

type RedisSet = { redisSet: (key: string, value: string) => Promise<unknown> };

export const buildTaxRateCacheWorkerWith = (overrides: Partial<JobDeps & RedisSet> = {}) =>
  modelJob({ min: 0 }, async () => {
    const redisSet = overrides.redisSet ?? ((key, value) => getRedis("main").set(key, value));
    const rows = await selectRows<{ maximum_combined_rate: Prisma.Decimal | null; zip_tax_rates_state: string }>(
      Prisma.sql`SELECT MAX(${column(ZIP_TAX_RATES, "combined_rate")}) AS ${Prisma.raw("`maximum_combined_rate`")}, ${column(ZIP_TAX_RATES, "state")} AS ${Prisma.raw("`zip_tax_rates_state`")} FROM ${table(ZIP_TAX_RATES)} WHERE (state is NOT NULL) GROUP BY ${column(ZIP_TAX_RATES, "state")}`,
    );
    for (const row of rows) {
      const rate = row.maximum_combined_rate;
      // redis-rb's #set sends `value.to_s`; a state whose rates are all NULL caches "".
      await redisSet(namespacedKey("max_tax_rate_per_state_cache_us", `US_${row.zip_tax_rates_state}`), rate === null ? "" : bigDecimalToS(new Prisma.Decimal(rate)));
    }
  })(overrides);

export const recoverAusBacktaxesFromStripeAccountsJob = recoverAusBacktaxesFromStripeAccountsJobWith();
export const alertOnStalledAbandonedCartEmailsJob = alertOnStalledAbandonedCartEmailsJobWith();
export const buildTaxRateCacheWorker = buildTaxRateCacheWorkerWith();
