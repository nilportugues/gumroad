// Ports of the payout, abandoned-purchase, balance and Stripe event jobs that can be decided in Node
// without reaching a payment processor:
//   app/sidekiq/large_sellers_update_user_balance_stats_cache_worker.rb  (in full)
//   app/sidekiq/handle_stripe_event_worker.rb      (event types StripeEventHandler ignores, and platform-account events it routes nowhere)
//   app/sidekiq/execute_scheduled_payouts_job.rb   (nothing due)
//   app/sidekiq/sync_stuck_payouts_job.rb          (nothing stuck)
//   app/sidekiq/update_payout_status_worker.rb     (a payment that is not processing)
//   app/sidekiq/fail_abandoned_purchase_worker.rb  (not in progress, and the 15 minute SCA guard)
//   app/sidekiq/low_balance_fraud_check_worker.rb  (a balance above the threshold)
//   app/sidekiq/handle_payout_reversed_worker.rb   (the Stripe read, and a payout that failed or is not final)
// Everything else in those jobs (payouts, PayPal and Stripe calls, probation writes, event handlers) is
// handed back to Rails before the job's first write. Golden: __fixtures__/payment-processor-jobs.golden.json
// (scripts/golden/payment-processor-jobs.rb).
import { Prisma, type Purchase } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { pushBulkWith } from "../../server/jobs/push-bulk.ts";
import { currentJobsRuntime, performAsync } from "../../server/models/concerns/job-runtime.ts";
import { rubyStringToBigInt } from "../../server/models/concerns/ruby-numeric.ts";
import { ago, rubyTimeToF } from "../../server/models/concerns/ruby-time.ts";
import { findPurchaseBang, purchaseIdFrom } from "../../server/models/purchase.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { stripePlatformAccountId } from "../../server/stripe/config.ts";
import { Payout } from "../../server/stripe/resources.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

// ActiveRecord::Batches::DEFAULT_BATCH_SIZE
const FIND_EACH_BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------------------------
// LargeSellersUpdateUserBalanceStatsCacheWorker

const UPDATE_USER_BALANCE_STATS_CACHE_WORKER = "UpdateUserBalanceStatsCacheWorker";
const STAGGER_WINDOW_SECONDS = 3_600;
const PUSH_BULK_BATCH_SIZE = 1_000;
// UserBalanceStatsService::DEFAULT_SALES_CACHING_THRESHOLD
const DEFAULT_SALES_CACHING_THRESHOLD = 50_000;
// RedisKey.balance_stats_sales_caching_threshold, RedisKey.balance_stats_users_excluded_from_caching
const SALES_CACHING_THRESHOLD_KEY = "balance_stats:sales_caching_threshold";
const USERS_EXCLUDED_FROM_CACHING_KEY = "balance_stats:users_excluded_from_caching";

export type BalanceStatsDeps = { redis: () => Redis; pushBulkBatchSize: number };

// UserBalanceStatsService.cacheable_users.pluck(:id). Any Redis failure reads as nobody being
// cacheable (`rescue *REDIS_TRANSPORT_ERRORS` returns User.none): an exclusion set that could not be
// read must not read as an empty one.
async function cacheableUserIds(redis: Redis): Promise<bigint[]> {
  let threshold: string | null;
  let excluded: string[];
  try {
    threshold = await redis.get(SALES_CACHING_THRESHOLD_KEY);
    excluded = await redis.smembers(USERS_EXCLUDED_FROM_CACHING_KEY);
  } catch {
    return [];
  }
  const salesThreshold = threshold === null ? BigInt(DEFAULT_SALES_CACHING_THRESHOLD) : rubyStringToBigInt(threshold);
  // The bound values are interpolated as quoted strings, as ActiveRecord renders them.
  const conditions = [Prisma.sql`(large_sellers.sales_count >= ${String(salesThreshold)})`];
  if (excluded.length > 0) conditions.push(Prisma.sql`(large_sellers.user_id NOT IN (${Prisma.join(excluded, ", ")}))`);
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} INNER JOIN ${table("large_sellers")} ON ${column("large_sellers", "user_id")} = ${column("users", "id")} WHERE ${Prisma.join(conditions, " AND ")}`,
  );
  return rows.map((row) => row.id);
}

const jobId = (id: bigint) => (id > BigInt(Number.MAX_SAFE_INTEGER) ? id : Number(id));

export const largeSellersUpdateUserBalanceStatsCacheWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extra: Partial<BalanceStatsDeps> = {},
) => {
  const redis = extra.redis ?? (() => getRedis("main"));
  const batchSize = extra.pushBulkBatchSize ?? PUSH_BULK_BATCH_SIZE;
  return modelJob({ min: 0 }, async (_args, deps) => {
    const userIds = await beforeSideEffects(() => cacheableUserIds(redis()));
    if (userIds.length === 0) return;

    const delayStep = STAGGER_WINDOW_SECONDS / userIds.length;
    const baseTime = rubyTimeToF(deps.now());
    for (let offset = 0; offset < userIds.length; offset += batchSize) {
      const slice = userIds.slice(offset, offset + batchSize);
      await pushBulkWith(currentJobsRuntime(), {
        class: UPDATE_USER_BALANCE_STATS_CACHE_WORKER,
        args: slice.map((id) => [jobId(id)]),
        at: slice.map((_, i) => baseTime + (offset + i) * delayStep),
      });
    }
  })(overrides);
};

// ---------------------------------------------------------------------------------------------
// HandleStripeEventWorker

// StripeEventHandler::ALL_HANDLED_EVENTS: the prefixes, then StripeChargeProcessor::HANDLED_REFUND_EVENTS.
const HANDLED_EVENT_PREFIXES = [
  "account.application.deauthorized",
  "account.updated",
  "capability.updated",
  "payout.",
  "charge.",
  "capital.",
  "radar.",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "checkout.session.completed",
  "customer.subscription.",
  "refund.updated",
  "refund.failed",
];

// Handled prefixes that `handle_event_for_gumroad` (no connected account, or the platform's own id)
// routes to no handler: it only dispatches charge., capital., radar., refund and payment_intent.
// events to the charge processor and checkout.session / customer.subscription. to SellerPlan.
const PLATFORM_ACCOUNT_NOOP_PREFIXES = [
  "account.application.deauthorized",
  "account.updated",
  "capability.updated",
  "payout.",
];

// `stripe_connect_account_id.present? && != STRIPE_PLATFORM_ACCOUNT_ID`
function isConnectedAccountEvent(params: Record<string, unknown>): boolean {
  const accountId = isBlank(params.user_id) ? params.account : params.user_id;
  return !isBlank(accountId) && accountId !== stripePlatformAccountId();
}

// Every handled event ends in a charge processor call, a Stripe API read or a ledger write, except the
// ones the handler logs and drops and the platform-account events nothing routes. `params[:type].to_s`: a
// type that is not a String (a Number, an Array, null) never starts with a prefix; a payload that is not
// an object fails in `to_hash`, which Node leaves to Ruby.
export const handleStripeEventWorker = modelJob({ min: 1 }, async ([params]) => {
  await beforeSideEffects(() => {
    if (params === null || typeof params !== "object" || Array.isArray(params))
      throw new NotPortedError("StripeEventHandler#initialize", "params is not a Hash");
    const event = params as Record<string, unknown>;
    const type = event.type;
    if (typeof type !== "string" || !HANDLED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) return;
    if (!isConnectedAccountEvent(event) && PLATFORM_ACCOUNT_NOOP_PREFIXES.some((prefix) => type.startsWith(prefix)))
      return;
    throw new NotPortedError(
      "StripeEventHandler#handle_stripe_event",
      "stripe_event_handler.rb:handle_stripe_event (charge processor, Stripe API reads and ledger writes)",
    );
  });
})();

// ---------------------------------------------------------------------------------------------
// ExecuteScheduledPayoutsJob

// `ScheduledPayout.due.find_each`: an empty first batch is the whole job. `execute!` locks the row,
// flags it or moves money, so a due payout goes to Rails.
export const executeScheduledPayoutsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const t = "scheduled_payouts";
  const due = Prisma.sql`${column(t, "status")} = 'pending' AND ${column(t, "scheduled_at")} <= ${deps.now()}`;
  await beforeSideEffects(() =>
    findInBatches(t, due, FIND_EACH_BATCH_SIZE, async () => {
      throw new NotPortedError(
        "ScheduledPayout#execute!",
        "scheduled_payout.rb:execute! (row lock, refund and payout enqueues)",
      );
    }),
  );
});

// ---------------------------------------------------------------------------------------------
// SyncStuckPayoutsJob

const STRIPE_PROCESSOR = "STRIPE";
const CREATING_STUCK_AFTER = { hours: 24 };
const PROCESSING_STUCK_AFTER = { days: 3 };

// Payment.where(processor:, state: stuck states) and, for Stripe, the age conditions. `Date.current`
// is the day, not the instant.
function stuckPaymentsCondition(processor: string, now: Date): Prisma.Sql {
  const t = "payments";
  const states = ["creating", "processing"];
  if (processor !== STRIPE_PROCESSOR) states.push("unclaimed");
  const base = Prisma.sql`${column(t, "processor")} = ${processor} AND ${columnIn(t, "state", states)}`;
  if (processor !== STRIPE_PROCESSOR) return base;
  const today = now.toISOString().slice(0, 10);
  return Prisma.sql`${base} AND (${stuckAgeSql(ago(CREATING_STUCK_AFTER, now), today, ago(PROCESSING_STUCK_AFTER, now))})`;
}

function stuckAgeSql(creatingCutoff: Date, today: string, processingCutoff: Date): Prisma.Sql {
  return Prisma.sql`(state = 'creating' AND created_at < ${creatingCutoff}) OR (state = 'processing' AND ((JSON_EXTRACT(json_data, '$.arrival_date') IS NOT NULL AND FROM_UNIXTIME(JSON_EXTRACT(json_data, '$.arrival_date')) < ${today}) OR (JSON_EXTRACT(json_data, '$.arrival_date') IS NULL AND created_at < ${processingCutoff})))`;
}

// A stuck payment is synced with its payout processor (a Stripe or PayPal call and a state change),
// which Rails does; an empty first batch is the whole job.
export const syncStuckPayoutsJobWith = modelJob({ min: 1 }, async ([processor], deps) => {
  await beforeSideEffects(() => {
    if (typeof processor !== "string")
      throw new NotPortedError("SyncStuckPayoutsJob#perform", "the processor is not a String");
    return findInBatches("payments", stuckPaymentsCondition(processor, deps.now()), FIND_EACH_BATCH_SIZE, async () => {
      throw new NotPortedError(
        "Payment#sync_with_payout_processor",
        "payment.rb:sync_with_payout_processor (payout processor call)",
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// UpdatePayoutStatusWorker

// A payment that is not processing is left alone. A processing one asks PayPal for its state (and
// may be a split payment saved part by part), so it goes to Rails.
export const updatePayoutStatusWorker = modelJob({ min: 1 }, async ([paymentId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(paymentId, "Payment.find"));
  const payment = await findByIdBang<{ state: string | null }>("Payment", id);
  if (payment.state !== "processing") return;
  await beforeSideEffects(() => {
    throw new NotPortedError(
      "PaypalPayoutProcessor.get_latest_payment_state_from_paypal",
      "update_payout_status_worker.rb (PayPal transaction search)",
    );
  });
})();

// ---------------------------------------------------------------------------------------------
// FailAbandonedPurchaseWorker

const FAIL_ABANDONED_PURCHASE_WORKER = "FailAbandonedPurchaseWorker";
// ChargeProcessor::TIME_TO_COMPLETE_SCA
const TIME_TO_COMPLETE_SCA_MS = 15 * 60 * 1000;

// Checking the intent at the processor and cancelling it is Rails', as is everything after the time
// guard. The guard itself reschedules the job, which Node does when the purchase is too young.
export const failAbandonedPurchaseWorkerWith = modelJob({ min: 1 }, async ([purchaseIdArg], deps) => {
  const id = await beforeSideEffects(() => purchaseIdFrom(purchaseIdArg));
  const purchase = await findPurchaseBang(id);
  if (purchase.purchase_state !== "in_progress") return;

  if (purchase.created_at === null) throw new TypeError("undefined method '+' for nil");
  const dueAt = new Date(purchase.created_at.getTime() + TIME_TO_COMPLETE_SCA_MS);
  if (dueAt.getTime() > deps.now().getTime()) {
    await performAsync(FAIL_ABANDONED_PURCHASE_WORKER, [purchaseIdArg as number | string], { at: dueAt });
    return;
  }
  await beforeSideEffects(() => {
    throw new NotPortedError(
      "FailAbandonedPurchaseWorker#with_stripe_error_handler",
      "fail_abandoned_purchase_worker.rb (Stripe intent retrieve and cancel)",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// LowBalanceFraudCheckWorker

// User::LowBalanceFraudCheck::LOW_BALANCE_THRESHOLD
const LOW_BALANCE_THRESHOLD_CENTS = -10_000n;

// `user.unpaid_balance_cents`: balances.unpaid.sum(:amount_cents)
async function unpaidBalanceCents(userId: unknown): Promise<bigint> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${userId} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const sum = Object.values(row!)[0];
  return sum == null ? 0n : BigInt((sum as { toString(): string }).toString());
}

// A balance above the threshold ends the job. Below it Rails mails the team and probates the seller
// (writes in a transaction, a mailer enqueue).
export const lowBalanceFraudCheckWorker = modelJob({ min: 1 }, async ([purchaseIdArg]) => {
  const id = await beforeSideEffects(() => purchaseIdFrom(purchaseIdArg));
  const purchase: Purchase = await findPurchaseBang(id);
  const seller = await findOneBy("User", "id", purchase.seller_id);
  if (seller === null) throw new TypeError("undefined method 'check_for_low_balance_and_probate' for nil");
  if ((await unpaidBalanceCents(seller.id)) > LOW_BALANCE_THRESHOLD_CENTS) return;
  await beforeSideEffects(() => {
    throw new NotPortedError(
      "User#check_for_low_balance_and_probate",
      "user/low_balance_fraud_check.rb (AdminMailer.low_balance_notify, disable_refunds_and_put_on_probation!)",
    );
  });
})();

// ---------------------------------------------------------------------------------------------
// HandlePayoutReversedWorker

// `reversing_payout["balance_transaction"]["status"]`: a missing or null balance transaction fails on
// nil; a String (not expanded) answers String#[] with a substring or nil, never "available".
function balanceTransactionStatus(payout: Record<string, unknown>): unknown {
  const balanceTransaction = payout.balance_transaction;
  if (balanceTransaction === undefined || balanceTransaction === null)
    throw new TypeError("undefined method '[]' for nil");
  if (typeof balanceTransaction === "string") return balanceTransaction.includes("status") ? "status" : null;
  if (typeof balanceTransaction === "object" && !Array.isArray(balanceTransaction))
    return (balanceTransaction as Record<string, unknown>).status ?? null;
  throw new NotPortedError(
    "HandlePayoutReversedWorker#balance_transaction_completed?",
    "balance_transaction is not an object",
  );
}

// A paid reversing payout whose balance transaction is available is recorded by
// `StripePayoutProcessor.handle_stripe_event_payout_reversed` (credits, balance writes), which Rails runs.
// The read before it is a GET, so handing the job back after it is safe.
export const handlePayoutReversedWorker = modelJob(
  { min: 3 },
  async ([paymentId, reversingPayoutId, stripeConnectAccountId]) => {
    await beforeSideEffects(() => {
      const printable = typeof paymentId === "string" || Number.isSafeInteger(paymentId);
      if (!printable || typeof reversingPayoutId !== "string" || typeof stripeConnectAccountId !== "string")
        throw new NotPortedError("Stripe::Payout.retrieve", "an id Node does not print as Ruby does");
    });
    const payout = (await Payout.retrieve(
      { id: reversingPayoutId as string, expand: ["balance_transaction"] },
      { stripeAccount: stripeConnectAccountId as string },
    )) as unknown as Record<string, unknown>;
    if (balanceTransactionStatus(payout) === "available" && payout.status === "paid") {
      // `Payment.find(payment_id)` is evaluated before the processor method is called.
      await findByIdBang("Payment", await beforeSideEffects(() => recordIdFrom(paymentId, "Payment.find")));
      await beforeSideEffects(() => {
        throw new NotPortedError(
          "StripePayoutProcessor.handle_stripe_event_payout_reversed",
          "stripe_payout_processor.rb (payout reversal credits and balance writes)",
        );
      });
    }
    if (payout.status === "failed") return;
    throw new Error(
      "Timed out waiting for reversing payout to become finalized (to transition to `failed` state or its balance transaction " +
        `to transition to \`available\` state). Payment ID: ${String(paymentId)}. Reversing payout ID: ${reversingPayoutId as string}`,
    );
  },
)();

export const largeSellersUpdateUserBalanceStatsCacheWorker = largeSellersUpdateUserBalanceStatsCacheWorkerWith();
export const executeScheduledPayoutsJob = executeScheduledPayoutsJobWith();
export const syncStuckPayoutsJob = syncStuckPayoutsJobWith();
export const failAbandonedPurchaseWorker = failAbandonedPurchaseWorkerWith();
