// Port of app/sidekiq/lift_platform_stripe_pause_job.rb (perform, sidekiq_retry_in and
// sidekiq_retries_exhausted), with the slice of Payment#failed_payouts_counted_toward_hold it reads.
// `ApplicationRecord.connected_to(role: :writing)` is a no-op here: the Node worker reads the primary.
import { Prisma, type Comment } from "@prisma/client";

import { Comments, COMMENT_TYPES } from "../../server/models/comment.ts";
import { aliveStripeAccountsOf, isGumroadManagedStripeAccount } from "../../server/models/merchant-account.ts";
import { rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { column, columnIn, selectRows, table } from "../../server/models/sql.ts";
import { findUser, isCompliant, isDeleted, isFlagSet, payoutsPausedBy, setFlag, setJsonDataForAttr, Users, type UserRecord } from "../../server/models/user.ts";
import { InvalidRequestError, PermissionError } from "../../server/stripe/errors.ts";
import { Account } from "../../server/stripe/resources.ts";
import type { RetriesExhausted, RetryIn } from "../retry.ts";
import { modelJob, defaultJobDeps } from "./support/job-deps.ts";

const AUTHOR_NAME = "platform-stripe-pause-lift";
const INTENT_PREFIX = "Lifting the platform Stripe pause on";
const LIFTED_PREFIX = "Lifted the platform Stripe pause on";
const CONFIRMED_PREFIX = "Confirmed the platform Stripe pause is lifted on";
const REPEATED_FAILED_PAYOUTS_AUTHOR = "pause_payouts_after_repeated_failures";
// User::SYSTEM_PAYOUT_PAUSING_COMMENT_AUTHORS
const SYSTEM_PAYOUT_PAUSING_AUTHORS = [REPEATED_FAILED_PAYOUTS_AUTHOR, "pause_payouts_for_seller_based_on_chargeback_rate"];
// StripePayoutProcessor::UNACCOUNTED_MONEY_HOLD_MARKER / MISSING_CAPABILITY_MESSAGE
const UNACCOUNTED_MONEY_HOLD_MARKER = "could not be accounted for";
const MISSING_CAPABILITY_MESSAGE = /needs to have at least one of the following capabilities enabled/u;
// Payment constants.
const MAX_CONSECUTIVE_FAILED_PAYOUTS = 3;
const CANNOT_PAY = "cannot_pay";
export const TERMINAL_PAYPAL_FAILURE_REASONS = ["PAYPAL 3148"];
export const TRANSIENT_AND_INTERNAL_REASONS = [
  "processor_rate_limited",
  "processor_unavailable",
  "unreversed_internal_transfer",
  "payout_outcome_unknown",
  "Transaction not found",
  "destination_ledger_negative",
  "destination_account_retired",
];
const STRIPE_PROCESSOR = "STRIPE";
const PAYPAL_PROCESSOR = "PAYPAL";

export class TransfersNotActiveYet extends Error {
  readonly rubyClass = "LiftPlatformStripePauseJob::TransfersNotActiveYet";
  constructor(message: string) {
    super(message);
    this.name = "TransfersNotActiveYet";
  }
}

// Stripe turns transfers back on in its own time: minutes between those retries, Sidekiq's default
// backoff for anything else. `TRANSFERS_RETRY_DELAYS[count].to_i` is 0 past the list.
const TRANSFERS_RETRY_DELAYS = [600, 1800, 3600];
export const liftPlatformStripePauseJobRetryIn: RetryIn = (count, error) => (error instanceof TransfersNotActiveYet ? (TRANSFERS_RETRY_DELAYS[count] ?? 0) : null);

type State = { charges_paused: unknown; payouts_paused: unknown; disabled_reason: unknown; past_due: boolean; transfers: unknown };
type Now = () => Date;

const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;
// Ruby's `a && a["b"]`: the first falsy link, else the last value.
function dig(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!truthy(current)) return current ?? null;
    current = (current as Record<string, unknown>)[key] ?? null;
  }
  return current;
}
const isPresent = (value: unknown) => truthy(value) && !(Array.isArray(value) && value.length === 0) && !(typeof value === "string" && value.trim() === "");
// #inspect of the JSON scalars a Stripe account carries.
const inspect = (value: unknown) => (value == null ? "nil" : typeof value === "string" ? JSON.stringify(value) : String(value));

function stateOf(account: unknown): State {
  return {
    charges_paused: dig(account, "risk_controls", "charges", "pause_requested"),
    payouts_paused: dig(account, "risk_controls", "payouts", "pause_requested"),
    disabled_reason: dig(account, "requirements", "disabled_reason"),
    past_due: isPresent(dig(account, "requirements", "past_due")) || isPresent(dig(account, "future_requirements", "past_due")),
    transfers: dig(account, "capabilities", "transfers"),
  };
}

const describe = (s: State) =>
  `charges paused: ${inspect(s.charges_paused)}, payouts paused: ${inspect(s.payouts_paused)}, ` +
  `disabled reason: ${inspect(s.disabled_reason)}, past due: ${String(s.past_due)}, transfers: ${inspect(s.transfers)}`;

const isClear = (s: State | null) =>
  s !== null && !truthy(s.charges_paused) && s.payouts_paused === false && !s.past_due && (s.disabled_reason == null || s.disabled_reason === "platform_paused");

function reasonToSkip(s: State): string | null {
  if (s.payouts_paused !== false) return "payouts are paused too, or their state is unknown, so the hold may be deliberate";
  if (!truthy(s.charges_paused)) return "the charges pause is not set";
  if (s.disabled_reason !== "platform_paused") return `the account is disabled for ${inspect(s.disabled_reason)}, not platform_paused`;
  return s.past_due ? "Stripe still lists past-due requirements" : null;
}

// Re-flagged, suspended or closed since the transition: the pause is no longer ours to lift.
const isEligible = (user: UserRecord | null): user is UserRecord => user !== null && isCompliant(user) && !isDeleted(user);

const userComments = (user: UserRecord) => Prisma.sql`${column("comments", "commentable_id")} = ${user.get("id")} AND ${column("comments", "commentable_type")} = 'User'`;

async function latestNote(user: UserRecord, stripeAccountId: string): Promise<{ content: string | null } | undefined> {
  const [row] = await selectRows<{ content: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${userComments(user)} AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.NOTE} AND ${column("comments", "author_name")} = ${AUTHOR_NAME} AND (content LIKE ${`%${stripeAccountId}%`}) ORDER BY ${column("comments", "created_at")} DESC, ${column("comments", "id")} DESC LIMIT 1`,
  );
  return row;
}

async function pendingIntentNote(user: UserRecord, stripeAccountId: string): Promise<boolean> {
  return (await latestNote(user, stripeAccountId))?.content?.startsWith(INTENT_PREFIX) ?? false;
}

async function liftedByUs(user: UserRecord, stripeAccountId: string): Promise<boolean> {
  const content = (await latestNote(user, stripeAccountId))?.content;
  return isPresent(content) && (content!.startsWith(LIFTED_PREFIX) || content!.startsWith(CONFIRMED_PREFIX));
}

async function addNote(user: UserRecord, content: string, now: Now, commentType: string = COMMENT_TYPES.NOTE): Promise<void> {
  await Comments.createBang({ commentable_id: BigInt(user.get("id") as bigint), commentable_type: "User", author_name: AUTHOR_NAME, comment_type: commentType, content } as Partial<Comment>, {
    now,
  });
}

async function liftPause(user: UserRecord, stripeAccountId: string, now: Now): Promise<State | null> {
  try {
    const before = stateOf(await Account.retrieve(stripeAccountId));
    const pending = await pendingIntentNote(user, stripeAccountId);
    if (!truthy(before.charges_paused) && (pending || (await liftedByUs(user, stripeAccountId)))) {
      // Stripe applied an earlier lift whose response never reached us: record it now.
      if (pending) {
        await addNote(
          user,
          `${CONFIRMED_PREFIX} ${stripeAccountId}. An earlier attempt started the lift but did not record its result. Now: ${describe(before)}.`,
          now,
        );
      }
      return before;
    }
    if (!(truthy(before.charges_paused) || before.disabled_reason === "platform_paused")) return before;

    const skip = reasonToSkip(before);
    if (skip) {
      await addNote(user, `Left the platform Stripe pause on ${stripeAccountId}: ${skip}. Before: ${describe(before)}.`, now);
      return before;
    }
    // The risk state can change while Stripe answers, so look again right before the write.
    if (!isEligible(await findUser(user.get("id")))) {
      if (pending) await addNote(user, `Did not lift the platform Stripe pause on ${stripeAccountId}: the seller is no longer eligible.`, now);
      return null;
    }
    await addNote(user, `${INTENT_PREFIX} ${stripeAccountId} after the account was marked compliant. Before: ${describe(before)}.`, now);
    const after = stateOf(await Account.update(stripeAccountId, { risk_controls: { charges: { pause_requested: false } } }));
    await addNote(user, `${LIFTED_PREFIX} ${stripeAccountId} after the account was marked compliant. Before: ${describe(before)}. After: ${describe(after)}.`, now);
    return after;
  } catch (error) {
    if (!(error instanceof InvalidRequestError || error instanceof PermissionError)) throw error;
    await addNote(user, `Could not lift the platform Stripe pause on ${stripeAccountId}: ${error.message}`, now);
    return null;
  }
}

// User#repeated_failed_payouts_hold_started_at
async function repeatedFailedPayoutsHoldStartedAt(user: UserRecord): Promise<Date | null> {
  if (!isFlagSet(user, "payouts_paused_internally") || payoutsPausedBy(user) !== "system") return null;
  const [comment] = await selectRows<{ author_name: string | null; created_at: Date }>(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${userComments(user)} AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.ON_PROBATION} AND ${columnIn("comments", "author_name", SYSTEM_PAYOUT_PAUSING_AUTHORS)} ORDER BY ${column("comments", "created_at")} DESC, ${column("comments", "id")} DESC LIMIT 1`,
  );
  return comment?.author_name === REPEATED_FAILED_PAYOUTS_AUTHOR ? comment.created_at : null;
}

const firstValue = <T>(row: Record<string, unknown> | undefined) => (row ? (Object.values(row)[0] as T | null) : null);

async function unaccountedMoneyHold(user: UserRecord): Promise<boolean> {
  const lastResumedAt = firstValue<Date>(
    (
      await selectRows<Record<string, unknown>>(
        Prisma.sql`SELECT MAX(${column("comments", "created_at")}) FROM ${table("comments")} WHERE ${userComments(user)} AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.PAYOUTS_RESUMED}`,
      )
    )[0],
  );
  const since = lastResumedAt ? Prisma.sql` AND (created_at >= ${lastResumedAt})` : Prisma.empty;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("comments")} WHERE ${userComments(user)} AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.ON_PROBATION} AND ${column("comments", "author_name")} = ${REPEATED_FAILED_PAYOUTS_AUTHOR} AND (content LIKE ${`%${UNACCOUNTED_MONEY_HOLD_MARKER}%`})${since} LIMIT 1`,
  );
  return rows.length > 0;
}

// When each account's pause was lifted, per the notes. A "Confirmed" note counts from the intent
// note before it, so failures after the real lift are not credited to the pause.
async function liftedAtByAccount(user: UserRecord): Promise<Map<string, Date>> {
  const rows = await selectRows<{ content: string; created_at: Date }>(
    Prisma.sql`SELECT ${column("comments", "content")}, ${column("comments", "created_at")} FROM ${table("comments")} WHERE ${userComments(user)} AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.NOTE} AND ${column("comments", "author_name")} = ${AUTHOR_NAME} ORDER BY ${column("comments", "created_at")} ASC, ${column("comments", "id")} ASC`,
  );
  const intentAt = new Map<string, Date>();
  const result = new Map<string, Date>();
  for (const { content, created_at: createdAt } of rows) {
    const accountId = content.match(/acct_[A-Za-z0-9_]+/u)?.[0];
    if (!accountId) continue;
    if (content.startsWith(INTENT_PREFIX)) intentAt.set(accountId, createdAt);
    if (!(content.startsWith(LIFTED_PREFIX) || content.startsWith(CONFIRMED_PREFIX))) continue;
    const liftedAt = content.startsWith(CONFIRMED_PREFIX) ? (intentAt.get(accountId) ?? createdAt) : createdAt;
    const previous = result.get(accountId);
    result.set(accountId, previous && previous > liftedAt ? previous : liftedAt);
  }
  return result;
}

type PaymentRow = {
  id: bigint;
  user_id: bigint;
  processor: string | null;
  bank_account_id: bigint | null;
  stripe_connect_account_id: string | null;
  payment_address: string | null;
  failure_reason: string | null;
  json_data: string | null;
  created_at: Date;
};

const paymentJson = (payment: PaymentRow): Record<string, unknown> => {
  const data = isPresent(payment.json_data) ? (rubyJsonParse(payment.json_data!) as unknown) : null;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
};

// Payment#failed_payouts_counted_toward_hold: the failures to this payment's destination since its
// last completed payout, or null when the destination cannot be identified. tripping_failures then
// loads them only when there are enough to trip the hold (null otherwise), as here.
async function failedPayoutsCountedTowardHold(payment: PaymentRow): Promise<PaymentRow[] | null> {
  const userId = payment.user_id;
  const destinationId = paymentJson(payment).stripe_payout_destination_id;
  let scope: Prisma.Sql;
  if (payment.bank_account_id != null) {
    scope = Prisma.sql`${column("payments", "user_id")} = ${userId} AND ${column("payments", "bank_account_id")} = ${payment.bank_account_id}`;
  } else if (payment.processor === STRIPE_PROCESSOR && isPresent(destinationId)) {
    const account = payment.stripe_connect_account_id == null ? Prisma.sql` IS NULL` : Prisma.sql` = ${payment.stripe_connect_account_id}`;
    scope = Prisma.sql`${column("payments", "user_id")} = ${userId} AND ${column("payments", "processor")} = ${payment.processor} AND ${column("payments", "stripe_connect_account_id")}${account} AND (json_data->>'$.stripe_payout_destination_id' = ${destinationId})`;
  } else if (payment.processor === PAYPAL_PROCESSOR && isPresent(payment.payment_address)) {
    scope = Prisma.sql`${column("payments", "user_id")} = ${userId} AND ${column("payments", "processor")} = ${PAYPAL_PROCESSOR} AND ${column("payments", "payment_address")} = ${payment.payment_address}`;
  } else {
    return null;
  }
  scope = Prisma.sql`${scope} AND (COALESCE(payments.json_data->>'$.retired_account_drain', '') != 'true')`;

  const lastCompletedAt = firstValue<Date>(
    (await selectRows<Record<string, unknown>>(Prisma.sql`SELECT MAX(${column("payments", "created_at")}) FROM ${table("payments")} WHERE ${scope} AND ${column("payments", "state")} = 'completed'`))[0],
  );
  const since = lastCompletedAt ? Prisma.sql` AND (created_at > ${lastCompletedAt})` : Prisma.empty;
  const where = Prisma.sql`${scope} AND ${column("payments", "state")} IN ('failed', 'returned') AND (failure_reason IS NULL OR failure_reason NOT IN (${Prisma.join(TERMINAL_PAYPAL_FAILURE_REASONS, ", ")}))${since} AND (failure_reason IS NULL OR failure_reason NOT IN (${Prisma.join(TRANSIENT_AND_INTERNAL_REASONS, ", ")}))`;
  const [count] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT COUNT(*) FROM ${table("payments")} WHERE ${where}`);
  if (Number(firstValue<bigint>(count)) < MAX_CONSECUTIVE_FAILED_PAYOUTS) return null;
  return selectRows<PaymentRow>(Prisma.sql`SELECT ${Prisma.raw("`payments`.*")} FROM ${table("payments")} WHERE ${where}`);
}

// Counted per destination, as the hold itself is.
async function trippingFailures(user: UserRecord): Promise<PaymentRow[][]> {
  const payments = await selectRows<PaymentRow>(
    Prisma.sql`SELECT ${Prisma.raw("`payments`.*")} FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${user.get("id")} AND ${column("payments", "state")} IN ('failed', 'returned')`,
  );
  const firstPerDestination = new Map<string, PaymentRow>();
  for (const payment of payments) {
    const key = JSON.stringify([payment.processor, String(payment.bank_account_id), payment.stripe_connect_account_id, paymentJson(payment).stripe_payout_destination_id ?? null, payment.payment_address]);
    if (!firstPerDestination.has(key)) firstPerDestination.set(key, payment);
  }
  const result: PaymentRow[][] = [];
  for (const payment of firstPerDestination.values()) {
    const failures = await failedPayoutsCountedTowardHold(payment);
    if (failures) result.push(failures);
  }
  return result;
}

function causedByPlatformPause(payment: PaymentRow, liftedAt: Map<string, Date>): boolean {
  const lifted = liftedAt.get(payment.stripe_connect_account_id ?? "");
  const errorMessage = paymentJson(payment).error_message;
  return (
    payment.processor === STRIPE_PROCESSOR &&
    (payment.failure_reason === CANNOT_PAY || payment.failure_reason == null) &&
    MISSING_CAPABILITY_MESSAGE.test(errorMessage == null ? "" : String(errorMessage)) &&
    lifted !== undefined &&
    payment.created_at <= lifted
  );
}

// Nothing else lifts the repeated-failed-payouts hold when its cause goes away, so release it here,
// but only when the lifted pause plausibly caused it.
async function releaseFailedPayoutHold(userId: unknown, transfersActive: boolean, now: Now): Promise<void> {
  const user = await findUser(userId);
  if (!isEligible(user)) return;
  await Users.withLock(user, async () => {
    if (!isEligible(user)) return;
    const holdStartedAt = await repeatedFailedPayoutsHoldStartedAt(user);
    if (holdStartedAt === null || (await unaccountedMoneyHold(user))) return;
    const liftedAt = await liftedAtByAccount(user);
    const tripping = await trippingFailures(user);
    if (tripping.length === 0) return;
    const liftedAts = tripping.flat().map((payment) => liftedAt.get(payment.stripe_connect_account_id ?? ""));
    if (liftedAts.some((at) => at === undefined)) return;
    if (holdStartedAt > new Date(Math.min(...liftedAts.map((at) => at!.getTime())))) return;
    if (!tripping.every((failures) => failures.every((payment) => causedByPlatformPause(payment, liftedAt)))) return;
    if (!transfersActive) throw new TransfersNotActiveYet("Stripe has not turned transfers back on for the account.");

    setFlag(user, "payouts_paused_internally", false);
    setJsonDataForAttr(user, "payouts_paused_by", null);
    await Users.saveBang(user, { now });
    await addNote(
      user,
      isFlagSet(user, "payouts_paused_by_user")
        ? "Automatic failed-payout hold lifted: its failed payouts came from the platform Stripe pause, which was lifted. Payouts remain paused by the creator."
        : "Payouts automatically resumed: the failed payouts behind the hold came from the platform Stripe pause, which was lifted.",
      now,
      COMMENT_TYPES.PAYOUTS_RESUMED,
    );
  });
}

export const liftPlatformStripePauseJobWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const user = await findUser(userId);
  if (!isEligible(user)) return;
  const accounts = (await aliveStripeAccountsOf(user.get("id"))).filter(isGumroadManagedStripeAccount);
  const states: (State | null)[] = [];
  for (const account of accounts) states.push(await liftPause(user, account.charge_processor_merchant_id as string, deps.now));
  // A hold may stand for a problem on any of the seller's accounts, so every one must be clear.
  if (states.length > 0 && states.every(isClear)) {
    await releaseFailedPayoutHold(user.get("id"), states.every((state) => state!.transfers === "active"), deps.now);
  }
});

// `new.abandon_pending_lifts` then, for TransfersNotActiveYet, `new.note_hold_kept`.
export function liftPlatformStripePauseJobRetriesExhaustedWith(now: Now = defaultJobDeps.now): RetriesExhausted {
  return async (msg, error) => {
    const userId = (msg.args as unknown[])[0];
    const message = error instanceof Error ? error.message : String(error);
    const user = await findUser(userId);
    if (user) {
      for (const account of await aliveStripeAccountsOf(user.get("id"))) {
        const stripeAccountId = account.charge_processor_merchant_id as string;
        if (!(await pendingIntentNote(user, stripeAccountId))) continue;
        await addNote(
          user,
          `Gave up lifting the platform Stripe pause on ${stripeAccountId} after repeated errors: ${message}. The pause may or may not have been lifted; check the account in Stripe.`,
          now,
        );
      }
    }
    if (!(error instanceof TransfersNotActiveYet)) return;
    const holder = await findUser(userId);
    if (!holder) return;
    // Under the lock, so a resume landing between the check and the note cannot leave a wrong note.
    await Users.withLock(holder, async () => {
      if ((await repeatedFailedPayoutsHoldStartedAt(holder)) === null) return;
      await addNote(holder, `Kept the failed-payout hold: ${message} Release it by hand once the account can receive transfers.`, now);
    });
  };
}

export const liftPlatformStripePauseJob = liftPlatformStripePauseJobWith();
export const liftPlatformStripePauseJobRetriesExhausted = liftPlatformStripePauseJobRetriesExhaustedWith();
