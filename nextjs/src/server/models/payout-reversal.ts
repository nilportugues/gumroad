// Port of the reversal of a failed payout's internal transfer: StripePayoutProcessor.reverse_internal_transfer_or_defer!,
// reverse_internal_transfer! and create_credit_for_difference_from_reversed_internal_transfer. Golden:
// scripts/golden/payouts-reversal.rb (statements and the Stripe calls with the number of statements before each).
//
// Reached after a Stripe POST, so nothing here may refuse: the only shape Rails handles differently is a sibling payout that
// awaits its cross-border bank payout (the reversal is then enqueued for later). Instant payouts need a United States legal
// entity, which is never cross-border, so a sibling is read and judged as Rails does and a cross-border one throws.
import { Prisma, type MerchantAccount, type UserComplianceInfo } from "@prisma/client";
import type Stripe from "stripe";

import { BalanceTransaction, Charge, Transfer } from "../stripe/resources.ts";

import { ago } from "./concerns/ruby-time.ts";
import { createForReturnedPaymentDifferenceBang } from "./credit-creation.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { isStripeConnectAccountRecord } from "./merchant-account.ts";
import { paymentUser, STRIPE_PROCESSOR, PAYMENT_STATES, type PaymentRecord } from "./payment.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { legalEntityCountryCode } from "./user-compliance-info.ts";
import { NoMethodError, NotPortedError } from "./user.ts";

// StripePayoutProcessor::CROSS_BORDER_PAYOUT_DELAY and DEFERRED_REVERSAL_GRACE
const DEFERRAL_WINDOW = { hours: 25 + 2 } as const;
const UNITED_STATES = "US";

const present = (value: unknown): boolean => value != null && String(value).trim() !== "";

// `credits.returned_payment_id` is not unique; `payment.credit` is the first row.
async function paymentCreditExists(payment: PaymentRecord): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`credits`.*")} FROM ${table("credits")} WHERE ${column("credits", "returned_payment_id")} = ${payment.get("id")} LIMIT 1`,
  );
  return rows.length > 0;
}

// `.to_i` on a Stripe attribute that is nil when the API leaves it out.
const toInt = (value: unknown): number => (value == null ? 0 : Number(value));

// StripePayoutProcessor.deferred_payout_awaiting_funds, then cross_border_payout?(sibling) on the result.
async function siblingAwaitingCrossBorderPayout(payment: PaymentRecord, now: Date): Promise<boolean> {
  if (payment.get("stripe_internal_transfer_id") == null || !present(payment.get("stripe_connect_account_id")))
    return false;
  const [sibling] = await selectRows<{
    id: bigint;
    user_id: bigint;
    processor: string;
    stripe_connect_account_id: string;
  }>(
    Prisma.sql`SELECT ${Prisma.raw("`payments`.*")} FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${payment.get("user_id")} AND ${column("payments", "processor")} = ${STRIPE_PROCESSOR} AND ${column("payments", "state")} = ${PAYMENT_STATES.PROCESSING} AND ${column("payments", "stripe_connect_account_id")} = ${payment.get("stripe_connect_account_id")} AND ${column("payments", "stripe_transfer_id")} IS NULL AND ${column("payments", "id")} != ${payment.get("id")} AND ${column("payments", "stripe_internal_transfer_id")} IS NOT NULL AND (created_at > ${ago(DEFERRAL_WINDOW, now)}) ORDER BY ${column("payments", "id")} ASC LIMIT 1`,
  );
  if (!sibling) return false;

  // cross_border_payout?(sibling): `payment.user.merchant_accounts.find_by(...)`, then the legal entity's country.
  const user = (await paymentUser(payment))!;
  const [accountRow] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${sibling.stripe_connect_account_id} LIMIT 1`,
  );
  if (
    accountRow &&
    isStripeConnectAccountRecord(MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", accountRow)))
  )
    return false;
  const [infoRow] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`user_compliance_info`.*")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "user_id")} = ${user.get("id")} AND ${column("user_compliance_info", "deleted_at")} IS NULL ORDER BY ${column("user_compliance_info", "id")} DESC LIMIT 1`,
  );
  if (!infoRow) return false;
  const country = legalEntityCountryCode(castRow<UserComplianceInfo>("UserComplianceInfo", infoRow));
  if (country === UNITED_STATES || country === null) return false;
  throw new NotPortedError(
    "ReverseDeferredInternalTransferJob for a cross-border sibling payout",
    "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb reverse_internal_transfer_or_defer!",
  );
}

// reverse_internal_transfer_or_defer!
export async function reverseInternalTransferOrDeferBang(
  payment: PaymentRecord,
  options: SaveOptions = {},
): Promise<void> {
  const now = options.now ? options.now() : new Date();
  if (await siblingAwaitingCrossBorderPayout(payment, now)) return;
  await reverseInternalTransferBang(payment, options);
}

// reverse_internal_transfer!
export async function reverseInternalTransferBang(payment: PaymentRecord, options: SaveOptions = {}): Promise<void> {
  const transferId = payment.get("stripe_internal_transfer_id");
  if (transferId == null) return;

  const internalTransfer = await Transfer.retrieve(transferId);
  // The transfer may already be reversed; Stripe rejects a second reversal, and the difference credit is still owed.
  if (toInt(internalTransfer.amount_reversed) < toInt(internalTransfer.amount))
    await Transfer.createReversal(internalTransfer.id);

  await createCreditForDifferenceFromReversedInternalTransfer(payment, internalTransfer, options);
}

function expandedNet(transaction: unknown): number {
  if (transaction === null || typeof transaction !== "object")
    throw new NoMethodError("undefined method 'net' for nil");
  return toInt((transaction as { net?: unknown }).net);
}

// create_credit_for_difference_from_reversed_internal_transfer
async function createCreditForDifferenceFromReversedInternalTransfer(
  payment: PaymentRecord,
  internalTransfer: Stripe.Transfer,
  options: SaveOptions,
): Promise<void> {
  // One difference credit per returned payout, so a retry records it once.
  if (await paymentCreditExists(payment)) return;

  const destination = internalTransfer.destination as string;
  const destinationPayment = await Charge.retrieve(
    { id: internalTransfer.destination_payment as string, expand: ["balance_transaction", "refunds"] },
    { stripeAccount: destination },
  );
  const refund = destinationPayment.refunds?.data[0];
  if (refund === undefined) throw new NoMethodError("undefined method 'balance_transaction' for nil");
  const refundBalanceTransaction = await BalanceTransaction.retrieve(
    { id: refund.balance_transaction as string },
    { stripeAccount: destination },
  );

  const differenceAmountCents =
    expandedNet(destinationPayment.balance_transaction) + expandedNet(refundBalanceTransaction);
  if (differenceAmountCents === 0) return;

  const user = (await paymentUser(payment))!;
  const [accountRow] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "charge_processor_id")} = 'stripe' AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${destination} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
  );
  const merchantAccount: MerchantAccountRecord | null = accountRow
    ? MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", accountRow))
    : null;
  // `credits.returned_payment_id` is not unique, so concurrent reversals serialize on the Payment row and re-check inside the lock.
  await transaction(async () => {
    await selectRows(
      Prisma.sql`SELECT ${column("payments", "id")} FROM ${table("payments")} WHERE ${column("payments", "id")} = ${payment.get("id")} LIMIT 1 FOR UPDATE`,
    );
    const existing = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("credits")} WHERE ${column("credits", "returned_payment_id")} = ${payment.get("id")} LIMIT 1`,
    );
    if (existing.length > 0) return;
    await createForReturnedPaymentDifferenceBang(
      { user, merchantAccount: merchantAccount!, returnedPayment: payment, differenceAmountCents },
      options,
    );
  });
}
