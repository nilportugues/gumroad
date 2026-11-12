// Port of StripePayoutProcessor.process_payments and perform_payment for a payout to the seller's bank account on a Gumroad-managed
// Stripe account: the payout request, what it records on the payment, and every failure branch with the bank account deletion, the
// reversal of the internal transfer and the hold that follow. Golden: scripts/golden/payouts-perform.rb.
//
// Refused with NotPortedError, before the payout request: an account retired by adoption, a Stripe Connect account (completed without
// a payout), a payout in a currency other than the account's, a retired-account drain, and a payment that names no bank account (the
// answer's destination would have to be recorded). Payouts.create_payments and prepare_payment_and_set_amount refuse the same shapes
// earlier in a request, so a caller that prepared the payment never reaches them.
import { Prisma, type BankAccount } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { notifyError } from "../infra/error-reporting.ts";
import {
  APIConnectionError,
  AuthenticationError,
  InvalidRequestError,
  RateLimitError,
  StripeError,
} from "../stripe/errors.ts";
import { Payout } from "../stripe/resources.ts";

import { BankAccountDeletable, BankAccounts } from "./bank-account.ts";
import { jsonDataForAttr, setJsonDataForAttr } from "./concerns/json-data.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "./merchant-account.ts";
import { reverseInternalTransferOrHoldPayoutsBang } from "./payment-hold.ts";
import { markFailedBang, Payments, paymentBalances, paymentUser, type PaymentRecord } from "./payment.ts";
import { FailureReason, stripeInvalidRequestErrorFailureReason } from "./payout-failure-reason.ts";
import { buildMetadataLargeList, STRIPE_METADATA_MAX_KEYS_LENGTH } from "./payout-prepare.ts";
import { PAYOUT_TYPE_INSTANT } from "./payouts.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const PROCESSOR_REF = "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb perform_payment";
const TRUNCATED_LENGTH = 1000;
const KRW = "krw";
const KRW_SUBUNITS = 100;

const truncate = (text: string) =>
  text.length <= TRUNCATED_LENGTH ? text : `${text.slice(0, TRUNCATED_LENGTH - 3)}...`;

// process_payments: every payment is tried, each failure is reported, and the first error is raised once all have run.
export async function processPaymentsBang(payments: PaymentRecord[], options: SaveOptions = {}): Promise<void> {
  let firstError: unknown = null;
  for (const payment of payments) {
    try {
      await performPaymentBang(payment, options);
    } catch (error) {
      notifyError(error, { payment_id: payment.get("id") });
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError as Error;
}

async function bankAccountOf(payment: PaymentRecord) {
  const id = payment.get("bank_account_id");
  if (id == null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`bank_accounts`.*")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "id")} = ${id} LIMIT 1`,
  );
  return row ? BankAccounts.load(castRow<BankAccount>("BankAccount", row)) : null;
}

// perform_payment: the errors, an empty list once the payout is requested.
export async function performPaymentBang(payment: PaymentRecord, options: SaveOptions = {}): Promise<string[]> {
  let failed = false;
  let failureReason: string | null = null;
  let payoutRequested = false;
  let bankAccount: Awaited<ReturnType<typeof bankAccountOf>> = null;
  try {
    const user = (await paymentUser(payment))!;
    const [account] = await selectRows<MerchantAccountRow>(
      Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${payment.get("stripe_connect_account_id")} LIMIT 1`,
    );
    if (!account) throw new TypeError("undefined method 'retired_by_adoption?' for nil");
    const raw = account as unknown as Record<string, unknown>;
    const retiredByAdoption = (() => {
      const data =
        typeof raw.json_data === "string" && raw.json_data.trim() !== ""
          ? (JSON.parse(raw.json_data) as Record<string, unknown>)
          : {};
      return data.retired_by_adoption_at != null && String(data.retired_by_adoption_at).trim() !== "";
    })();
    const active =
      raw.deleted_at == null && raw.charge_processor_alive_at != null && raw.charge_processor_deleted_at == null;
    if (retiredByAdoption || !active) throw new NotPortedError("a payout from a retired Stripe account", PROCESSOR_REF);
    if (isStripeConnectAccount(account))
      throw new NotPortedError("a payout completed without a bank payout", PROCESSOR_REF);
    if (String(payment.get("currency")) !== String(raw.currency ?? ""))
      throw new NotPortedError("a payout in a currency other than its account's", PROCESSOR_REF);

    const amountCents =
      payment.get("currency") === KRW
        ? Math.trunc(Number(payment.get("amount_cents")) / KRW_SUBUNITS)
        : Number(payment.get("amount_cents"));
    bankAccount = await bankAccountOf(payment);
    if (bankAccount === null) throw new NotPortedError("a payout that names no bank account", PROCESSOR_REF);

    const paymentExternalId = encrypt(payment.get("id"));
    const balanceIds = (await paymentBalances(payment)).map((balance) => encrypt(balance.get("id")));
    const payoutType = jsonDataForAttr(payment, "payout_type");
    const params: Record<string, unknown> = {
      amount: amountCents,
      currency: payment.get("currency"),
      statement_descriptor: "Gumroad",
      description: paymentExternalId,
      metadata: {
        payment: paymentExternalId,
        bank_account: encrypt(bankAccount.get("id")),
        ...buildMetadataLargeList(balanceIds, "balances", STRIPE_METADATA_MAX_KEYS_LENGTH - 2),
      },
      destination: bankAccount.get("stripe_bank_account_id"),
    };
    if (payoutType != null && String(payoutType).trim() !== "") params.method = payoutType;
    // Past this point a bank payout may exist at Stripe even if the response never arrives.
    payoutRequested = true;
    const stripePayout = await Payout.create(params as never, {
      stripeAccount: String(payment.get("stripe_connect_account_id")),
    });
    payment.set("stripe_transfer_id", stripePayout.id);
    setJsonDataForAttr(payment, "arrival_date", stripePayout.arrival_date);
    if (payoutType === PAYOUT_TYPE_INSTANT)
      setJsonDataForAttr(
        payment,
        "gumroad_fee_cents",
        (stripePayout as { application_fee_amount?: number | null }).application_fee_amount ?? null,
      );
    await Payments.saveBang(payment, options);
    return [];
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      failed = true;
      failureReason = stripeInvalidRequestErrorFailureReason(error);
      if (failureReason === null) notifyError(error);
      setJsonDataForAttr(payment, "error_message", truncate(error.message));
      return [error.message];
    }
    if (error instanceof AuthenticationError || error instanceof APIConnectionError) {
      failed = true;
      // The gem makes a fresh idempotency key per call, so requeueing could pay the seller twice: record an unknown outcome instead.
      failureReason = payoutRequested ? FailureReason.PAYOUT_OUTCOME_UNKNOWN : FailureReason.PROCESSOR_UNAVAILABLE;
      setJsonDataForAttr(payment, "error_message", truncate(`${error.rubyClass}: ${error.message}`));
      throw error;
    }
    if (error instanceof RateLimitError) {
      failed = true;
      failureReason = FailureReason.PROCESSOR_RATE_LIMITED;
      setJsonDataForAttr(payment, "error_message", truncate(error.message));
      notifyError(error);
      return [error.message];
    }
    if (error instanceof StripeError) {
      failed = true;
      setJsonDataForAttr(payment, "error_message", truncate(error.message));
      notifyError(error);
      return [error.message];
    }
    // Any other error leaves the payment as it is, as in Ruby: no rescue matches and `failed` stays false.
    throw error;
  } finally {
    if (failed) {
      await markFailedBang(payment, failureReason, options);
      // Mark the bank account deleted before the reversal so a transient Stripe error there cannot leave a dead bank alive.
      if (failureReason === FailureReason.BANK_ACCOUNT_NOT_FOUND_AT_STRIPE && bankAccount !== null)
        await BankAccountDeletable.markDeletedBang(bankAccount, options);
      await reverseInternalTransferOrHoldPayoutsBang(payment, failureReason, { ...options, reraise: true });
    }
  }
}
