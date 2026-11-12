// Port of app/models/payment.rb for a Stripe payout: the Payment queries the money jobs need, and the state machine's
// `mark_processing!` and `mark_failed!` with the callbacks they run (the balances back to unpaid, the cannot-pay and
// debit-card mails, the failure-reason payout note, the pause after repeated failures). Golden: scripts/golden/payment-state-machine.rb.
//
// Not ported, and refused with NotPortedError before anything is written: every other event (completed, cancelled, reversed,
// returned, unclaimed), the PayPal and other processors' validations and callbacks, and the sync_with_* methods.
import { Prisma, type Payment, type PaymentsBalance } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { fireBalanceEventBang, Balances, type BalanceRecord } from "./balance.ts";
import { COMMENT_TYPES, Comments } from "./comment.ts";
import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { RubyHash } from "./concerns/psych.ts";
import type { BelongsTo } from "./concerns/rails-validations.ts";
import { rubyJsonGenerate } from "./concerns/serialized-columns.ts";
import { gumroadAdminId } from "./gumroad-admin-id.ts";
import REASONS from "./payment-failure-reasons.generated.json" with { type: "json" };
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { InvalidTransition } from "./runtime/state-machine.ts";
import { transaction } from "./runtime/transaction.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import {
  isPayoutsPaused,
  jsonDataForAttr,
  NotPortedError,
  setFlag,
  setJsonDataForAttr,
  Users,
  type UserRecord,
} from "./user.ts";

export type PaymentRecord = ModelRecord<Payment>;

export const PAYMENT_STATES = {
  CREATING: "creating",
  PROCESSING: "processing",
  FAILED: "failed",
} as const;
export const STRIPE_PROCESSOR = "STRIPE";
// Payment::MAX_CONSECUTIVE_FAILED_PAYOUTS
export const MAX_CONSECUTIVE_FAILED_PAYOUTS = 3;
const PAYOUT_PAUSE_SOURCE_SYSTEM = "system";
const REPEATED_FAILED_PAYOUTS_AUTHOR = "pause_payouts_after_repeated_failures";
const CANNOT_PAY = "cannot_pay";
const DEBIT_CARD_LIMIT = "debit_card_limit";
const CRITICAL_QUEUE = "critical";
const FAILURE_EMAIL_PERIOD_KEY = "payout_date_of_last_payment_failure_email";
const SELLER_VISIBLE_FLAG = "seller_visible";

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
export const paymentUser = (payment: PaymentRecord) => readBelongsTo(payment, USER, Users);
export const assignPaymentUser = (payment: PaymentRecord, user: UserRecord) => assignBelongsTo(payment, USER, user);

// `user.payments.completed.where(stripe_connect_account_id:).order(:created_at).pluck(:stripe_internal_transfer_id)`
export async function completedInternalTransferIds(
  userId: unknown,
  stripeConnectAccountId: string,
): Promise<(string | null)[]> {
  const rows = await selectRows<{ stripe_internal_transfer_id: string | null }>(
    Prisma.sql`SELECT ${column("payments", "stripe_internal_transfer_id")} FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${userId} AND ${column("payments", "state")} = 'completed' AND ${column("payments", "stripe_connect_account_id")} = ${stripeConnectAccountId} ORDER BY ${column("payments", "created_at")} ASC`,
  );
  return rows.map((row) => row.stripe_internal_transfer_id);
}

const WAS_CREATED_IN_SPLIT_MODE = 1;
const jsonValue = (payment: PaymentRecord, key: string) => jsonDataForAttr(payment as never, key);
export const isRetiredAccountDrain = (payment: PaymentRecord) =>
  !isBlank(jsonValue(payment, "retired_account_drain") as string | null);
const hasSplitPaymentsInfo = (payment: PaymentRecord) => !isBlank(jsonValue(payment, "split_payments_info") as never);

export const Payments = defineModel<Payment>({
  rubyClass: "Payment",
  prismaModel: "Payment",
  delegate: (tx) => tx.payment as never,
  validations: [
    // state any { validates_presence_of :processor }; the other state validations exclude creating, processing and failed.
    {
      name: "state any validates_presence_of :processor",
      run(payment) {
        if (isBlank(payment.get("processor"))) payment.errors.add("processor", "blank");
      },
    },
    {
      name: "split_payment_validation",
      run(payment) {
        const split = (payment.get("flags") & WAS_CREATED_IN_SPLIT_MODE) !== 0;
        if (split && hasSplitPaymentsInfo(payment)) return;
        if (!split && !hasSplitPaymentsInfo(payment)) return;
        payment.errors.add(
          "base",
          "A split payment needs to have the was_created_in_split_mode flag set and needs to have split_payments_info",
        );
      },
    },
  ],
  beforeSave: [mergeJsonDataWithCurrentRow("payments")],
});

// Payment.find(id)
export async function findPaymentBang(id: unknown): Promise<PaymentRecord> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`payments`.*")} FROM ${table("payments")} WHERE ${column("payments", "id")} = ${id} LIMIT 1`,
  );
  if (!row) throw new RecordNotFound(`Couldn't find Payment with 'id'=${String(id)}`);
  return Payments.load(castRow<Payment>("Payment", row));
}

const balancesOf = new WeakMap<object, Promise<BalanceRecord[]>>();

// `payment.balances`: the has_and_belongs_to_many through payments_balances, loaded once per instance.
export function paymentBalances(payment: PaymentRecord): Promise<BalanceRecord[]> {
  let loaded = balancesOf.get(payment);
  if (!loaded) {
    loaded = selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} INNER JOIN ${table("payments_balances")} ON ${column("balances", "id")} = ${column("payments_balances", "balance_id")} WHERE ${column("payments_balances", "payment_id")} = ${payment.get("id")}`,
    ).then((rows) => rows.map((row) => Balances.load(castRow("Balance", row))));
    balancesOf.set(payment, loaded);
  }
  return loaded;
}

// `payment.balances = group_balances`: the association target is the balances the payout was claimed with, so a later read
// does not query for them.
export function setPaymentBalances(payment: PaymentRecord, balances: BalanceRecord[]): void {
  balancesOf.set(payment, Promise.resolve(balances));
}

const PaymentsBalances = defineModel<PaymentsBalance>({
  rubyClass: "PaymentsBalance",
  prismaModel: "PaymentsBalance",
  delegate: (tx) => tx.paymentsBalance as never,
});

export type NewPayment = {
  user: UserRecord;
  processor: string;
  payoutPeriodEndDate: Date;
  payoutType: string;
  createdAt: Date;
  currency: string;
  stripeConnectAccountId: string | null;
  bankAccountId: unknown;
  // The row `bank_account:` was assigned from, which stays loaded on the payment as the association target.
  bankAccountRow?: Record<string, unknown> | null;
  balances: BalanceRecord[];
};

const loadedBankAccounts = new WeakMap<object, Record<string, unknown>>();
// `payment.bank_account` when the payment was built with one in this process: no read, as the association is loaded.
export function loadedBankAccountRow(payment: PaymentRecord): Record<string, unknown> | null {
  const row = loadedBankAccounts.get(payment);
  return row !== undefined && String(row.id) === String(payment.get("bank_account_id")) ? row : null;
}

// Payment.create!(user:, balances:, processor:, processor_fee_cents: 0, payout_period_end_date:, payout_type:, created_at:,
// currency:, stripe_connect_account_id:, bank_account:) for a Stripe payout: the payment, then one payments_balances row per balance.
export function createPaymentBang(attributes: NewPayment, options: SaveOptions = {}): Promise<PaymentRecord> {
  return transaction(async () => {
    const payment = Payments.build({
      state: PAYMENT_STATES.CREATING,
      processor: attributes.processor,
      processor_fee_cents: 0,
      payout_period_end_date: attributes.payoutPeriodEndDate,
      created_at: attributes.createdAt,
      currency: attributes.currency,
      stripe_connect_account_id: attributes.stripeConnectAccountId,
      bank_account_id: attributes.bankAccountId as never,
    });
    assignPaymentUser(payment, attributes.user);
    setJsonDataForAttr(payment as never, "payout_type", attributes.payoutType);
    await Payments.saveBang(payment, options);
    for (const balance of attributes.balances)
      await PaymentsBalances.saveBang(
        PaymentsBalances.build({ payment_id: Number(payment.get("id")), balance_id: Number(balance.get("id")) }),
        options,
      );
    setPaymentBalances(payment, attributes.balances);
    if (attributes.bankAccountRow) loadedBankAccounts.set(payment, attributes.bankAccountRow);
    return payment;
  });
}

// Time#to_s of a UTC time: "2025-10-31 10:00:00 UTC".
function rubyTimeToS(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

// User#add_payout_note
async function addPayoutNote(
  user: UserRecord,
  content: string,
  sellerVisible: boolean,
  options: SaveOptions,
): Promise<void> {
  await Comments.createBang(
    {
      commentable_id: user.get("id") as never,
      commentable_type: "User",
      content,
      author_id: BigInt(gumroadAdminId() as number),
      comment_type: COMMENT_TYPES.PAYOUT_NOTE,
      json_data: rubyJsonGenerate(new RubyHash([[SELLER_VISIBLE_FLAG, sellerVisible]])),
    } as never,
    options,
  );
}

async function enqueueCreatorMail(method: string, paymentId: unknown): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    { mailer: "ContactingCreatorMailer", method, args: [Number(paymentId)], queue: CRITICAL_QUEUE },
    mailRoute("ContactingCreatorMailer", method),
  );
}

// Payment#send_cannot_pay_email
async function sendCannotPayEmail(payment: PaymentRecord, options: SaveOptions): Promise<void> {
  const user = (await paymentUser(payment))!;
  const periodEnd = payment.get("payout_period_end_date");
  const previous = jsonDataForAttr(user, FAILURE_EMAIL_PERIOD_KEY);
  if (!isBlank(previous as string | null)) {
    if (periodEnd === null) throw new TypeError("comparison of Date with nil failed");
    if (String(previous) >= dateOnly(periodEnd)) return;
  }
  await enqueueCreatorMail("cannot_pay", payment.get("id"));
  setJsonDataForAttr(user, FAILURE_EMAIL_PERIOD_KEY, periodEnd === null ? null : dateOnly(periodEnd));
  await Users.saveBang(user, options);
}

// Payment#add_payment_failure_reason_comment, for a Stripe payout.
async function addPaymentFailureReasonComment(payment: PaymentRecord, options: SaveOptions): Promise<void> {
  const reason = payment.get("failure_reason");
  if (isBlank(reason)) return;
  const solution = (REASONS.stripe_failure_solutions as Record<string, { reason: string; solution: string }>)[reason!];
  if (!solution) return;
  const user = (await paymentUser(payment))!;
  const content = `Payout via ${capitalize(payment.get("processor")!)} on ${rubyTimeToS(payment.get("created_at")!)} failed because ${solution.reason}. Solution: ${solution.solution}.`;
  await addPayoutNote(user, content, true, options);
}

// Payment#failed_payouts_counted_toward_hold: [destination label, the failed-or-returned count], or null when the destination
// cannot be identified.
async function failedPayoutsCountedTowardHold(
  payment: PaymentRecord,
): Promise<{ destination: string; count: number } | null> {
  const userId = payment.get("user_id");
  let destinationScope: Prisma.Sql;
  if (payment.get("bank_account_id") != null) {
    destinationScope = Prisma.sql`${column("payments", "user_id")} = ${userId} AND ${column("payments", "bank_account_id")} = ${payment.get("bank_account_id")}`;
  } else if (
    payment.get("processor") === STRIPE_PROCESSOR &&
    !isBlank(jsonValue(payment, "stripe_payout_destination_id") as string | null)
  ) {
    destinationScope = Prisma.sql`${column("payments", "user_id")} = ${userId} AND ${column("payments", "processor")} = ${payment.get("processor")} AND ${column("payments", "stripe_connect_account_id")} = ${payment.get("stripe_connect_account_id")} AND (json_data->>'$.stripe_payout_destination_id' = ${jsonValue(payment, "stripe_payout_destination_id")})`;
  } else {
    // PayPal destinations are not ported, and a payment with neither a bank account nor a Stripe destination has none.
    if (payment.get("processor") !== STRIPE_PROCESSOR)
      throw new NotPortedError("Payment#failed_payouts_counted_toward_hold for PayPal", "app/models/payment.rb");
    return null;
  }
  const retiredDrains = Prisma.raw("(COALESCE(payments.json_data->>'$.retired_account_drain', '') != 'true')");
  const scope = Prisma.sql`${destinationScope} AND ${retiredDrains}`;

  const [latest] = await selectRows<Record<string, Date | null>>(
    Prisma.sql`SELECT MAX(${column("payments", "created_at")}) FROM ${table("payments")} WHERE ${scope} AND ${column("payments", "state")} = 'completed'`,
  );
  const lastCompletedAt = latest ? (Object.values(latest)[0] ?? null) : null;
  const terminal = Prisma.join(REASONS.terminal_paypal_failure_reasons, ", ");
  const internal = Prisma.join([...REASONS.transient_reasons, ...REASONS.internal_reconciliation_reasons], ", ");
  const since = lastCompletedAt === null ? Prisma.empty : Prisma.sql` AND (created_at > ${lastCompletedAt})`;
  const [counted] = await selectRows<Record<string, bigint | number>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("payments")} WHERE ${scope} AND ${column("payments", "state")} IN ('failed', 'returned') AND (failure_reason IS NULL OR failure_reason NOT IN (${terminal}))${since} AND (failure_reason IS NULL OR failure_reason NOT IN (${internal}))`,
  );
  return { destination: "bank account", count: Number(Object.values(counted!)[0]) };
}

// Payment#pause_payouts_after_repeated_failures
async function pausePayoutsAfterRepeatedFailures(payment: PaymentRecord, options: SaveOptions): Promise<void> {
  if (payment.get("user_id") == null) return;
  const user = (await paymentUser(payment))!;
  if (isPayoutsPaused(user)) return;
  if (isRetiredAccountDrain(payment)) return;
  const counted = await failedPayoutsCountedTowardHold(payment);
  if (counted === null || counted.count < MAX_CONSECUTIVE_FAILED_PAYOUTS) return;

  setFlag(user, "payouts_paused_internally", true);
  setJsonDataForAttr(user, "payouts_paused_by", PAYOUT_PAUSE_SOURCE_SYSTEM);
  await Users.saveBang(user, options);
  await Comments.createBang(
    {
      commentable_id: user.get("id") as never,
      commentable_type: "User",
      content: `Payouts paused automatically after ${counted.count} consecutive failed payouts to the same ${counted.destination}. Verify the seller's payout details before resuming.`,
      comment_type: COMMENT_TYPES.ON_PROBATION,
      author_name: REPEATED_FAILED_PAYOUTS_AUTHOR,
    } as never,
    options,
  );
}

const refuseUnsupportedProcessor = (payment: PaymentRecord) => {
  if (payment.get("processor") !== STRIPE_PROCESSOR)
    throw new NotPortedError(
      `Payment state machine for the ${String(payment.get("processor"))} processor`,
      "app/models/payment.rb",
    );
};

// event :mark_processing { transition creating: :processing }
export async function markProcessingBang(payment: PaymentRecord, options: SaveOptions = {}): Promise<PaymentRecord> {
  const current = payment.get("state");
  if (current !== PAYMENT_STATES.CREATING) throw new InvalidTransition("state", "mark_processing", current);
  refuseUnsupportedProcessor(payment);
  return transaction(async () => {
    payment.set("state", PAYMENT_STATES.PROCESSING);
    return Payments.saveBang(payment, options);
  });
}

// event :mark_failed { transition %i[creating processing] => :failed }, with `before_transition any => :failed` writing the reason.
export async function markFailedBang(
  payment: PaymentRecord,
  failureReason: string | null = null,
  options: SaveOptions = {},
): Promise<PaymentRecord> {
  const from = payment.get("state");
  if (from !== PAYMENT_STATES.CREATING && from !== PAYMENT_STATES.PROCESSING)
    throw new InvalidTransition("state", "mark_failed", from);
  refuseUnsupportedProcessor(payment);
  return transaction(async () => {
    payment.set("failure_reason", failureReason);
    payment.set("state", PAYMENT_STATES.FAILED);
    await Payments.saveBang(payment, options);

    // after_transition %i[creating processing] => %i[cancelled failed]: mark_balances_as_unpaid
    for (const balance of await paymentBalances(payment)) await fireBalanceEventBang(balance, "mark_unpaid", options);
    if (from === PAYMENT_STATES.PROCESSING) {
      if (failureReason === CANNOT_PAY) await sendCannotPayEmail(payment, options);
      if (failureReason === DEBIT_CARD_LIMIT) await enqueueCreatorMail("debit_card_limit_reached", payment.get("id"));
      await addPaymentFailureReasonComment(payment, options);
    }
    await pausePayoutsAfterRepeatedFailures(payment, options);
    return payment;
  });
}
