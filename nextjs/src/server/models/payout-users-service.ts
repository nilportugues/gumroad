// Port of PayoutUsersService#process (app/services/payout_users_service.rb) and ProcessPaymentWorker#perform for the Stripe processor and
// a seller in the United States: Payouts.create_payments, the cross-border split, StripePayoutProcessor.process_payments. Golden:
// scripts/golden/payout-users-service.rb.
//
// Refused with NotPortedError before the first write: any other processor, several user ids (a refusal for the second would come after
// the first was claimed), a retried payout, a date or id Rails casts, and whatever Payouts.create_payments refuses. A cross-border
// payment would be deferred with ProcessPaymentWorker.perform_in; the claim refuses every country but the United States, so none exists.
import { Prisma } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { instantlyPayableUnpaidBalancesUpTo } from "./instant-payable-balances.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "./merchant-account.ts";
import { STRIPE_PROCESSOR, paymentUser, type PaymentRecord } from "./payment.ts";
import { performPaymentBang, processPaymentsBang } from "./payout-perform.ts";
import { preparePaymentAndSetAmount } from "./payout-prepare.ts";
import { aliveUserComplianceInfo } from "./payout-reads.ts";
import { PAYOUT_TYPE_INSTANT, PAYOUT_TYPE_STANDARD, createPaymentsBang } from "./payouts.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { column, selectRows, table } from "./sql.ts";
import { legalEntityCountryCode } from "./user-compliance-info.ts";
import { NotPortedError, findUserBang } from "./user.ts";

const SERVICE_REF = "app/services/payout_users_service.rb";
const WORKER_REF = "app/sidekiq/process_payment_worker.rb";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UNITED_STATES = "US";

export type PayoutUsersInput = {
  dateString: unknown;
  processorType: unknown;
  userIds: unknown;
  payoutType: unknown;
  retrying: unknown;
};

// `PayoutUsersService.new(...).process`, for one user and one date.
export async function processPayoutUsers(input: PayoutUsersInput, options: SaveOptions = {}): Promise<void> {
  if (input.processorType !== STRIPE_PROCESSOR)
    throw new NotPortedError("a payout through a processor other than Stripe", SERVICE_REF);
  if (input.retrying != null && input.retrying !== false) throw new NotPortedError("a retried payout", SERVICE_REF);
  if (input.payoutType !== PAYOUT_TYPE_STANDARD && input.payoutType !== PAYOUT_TYPE_INSTANT)
    throw new NotPortedError("a payout type other than standard or instant", SERVICE_REF);
  if (typeof input.dateString !== "string" || !DATE_PATTERN.test(input.dateString))
    throw new NotPortedError("a payout date that is not a YYYY-MM-DD string", SERVICE_REF);
  const userIds: unknown[] = Array.isArray(input.userIds) ? (input.userIds as unknown[]) : [input.userIds];
  if (userIds.length > 1) throw new NotPortedError("several users in one payout job", SERVICE_REF);
  const [userId] = userIds;
  if (userId === undefined || userId === null) return;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId))
    throw new NotPortedError("a user id that is not an Integer", SERVICE_REF);

  const payments: PaymentRecord[] = [];
  let committed = false;
  try {
    const user = await findUserBang(userId);
    let periodEnd = input.dateString;
    if (input.payoutType === PAYOUT_TYPE_INSTANT) {
      const balances = await instantlyPayableUnpaidBalancesUpTo(user, new Date(`${input.dateString}T00:00:00Z`));
      const last = balances.at(-1);
      // `.last.date` on an empty list is a NoMethodError, rescued below like any other error of the user's turn.
      if (last === undefined) throw new TypeError("undefined method 'date' for nil");
      periodEnd = (last.get("date") as unknown as Date).toISOString().slice(0, 10);
    }
    const created = await createPaymentsBang(new Date(`${periodEnd}T00:00:00Z`), user, {
      payoutType: input.payoutType,
      ...(options.now ? { now: options.now } : {}),
      prepare: (payment, claimed, merchantAccount, payoutCurrency) =>
        preparePaymentAndSetAmount(payment, claimed, merchantAccount, payoutCurrency, options, true),
    });
    committed = true;
    for (const [payment, errors] of created) {
      if (errors.length > 0) continue;
      if (await isCrossBorderPayout(payment))
        throw new Error("a cross-border payout reached Node, which the claim refuses");
      payments.push(payment);
    }
  } catch (error) {
    if (error instanceof NotPortedError && !committed) throw error;
    notifyError(error);
  }
  if (payments.length > 0) await processPaymentsBang(payments, options);
}

// `StripePayoutProcessor.cross_border_payout?`
async function isCrossBorderPayout(payment: PaymentRecord): Promise<boolean> {
  const user = (await paymentUser(payment))!;
  const [account] = await selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${payment.get("stripe_connect_account_id")} LIMIT 1`,
  );
  if (account && isStripeConnectAccount(account)) return false;
  const info = await aliveUserComplianceInfo(user);
  return info !== null && legalEntityCountryCode(info) !== UNITED_STATES;
}

// `ProcessPaymentWorker#perform` once the payment is read and is `processing`: `process_payments([payment])`.
export async function processStripePayment(payment: PaymentRecord, options: SaveOptions = {}): Promise<void> {
  if (payment.get("processor") !== STRIPE_PROCESSOR)
    throw new NotPortedError("a payout through a processor other than Stripe", WORKER_REF);
  const progress = { requested: false };
  try {
    await performPaymentBang(payment, options, progress);
  } catch (error) {
    if (error instanceof NotPortedError && !progress.requested) throw error;
    notifyError(error, { payment_id: payment.get("id") });
    // A refusal after the request left must fail the job, not hand it back to be run twice.
    throw error instanceof NotPortedError ? new Error(error.message) : error;
  }
}
