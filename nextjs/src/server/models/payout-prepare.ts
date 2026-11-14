// Port of StripePayoutProcessor.prepare_payment_and_set_amount (app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb)
// for the shapes Payouts.create_payments can claim: a Gumroad-managed account that is active, Stripe-held balances in its own
// currency and Gumroad-held ones. Golden: scripts/golden/payouts-prepare.rb (statements, Stripe calls and the statements before each).
//
// Refused with NotPortedError, before any Stripe call and any write: a destination that is not active (the retired-account drain and
// the retired-destination refusal) and a balance in a currency its account does not hold (a payable-currency probe). Both are refused
// by the claim earlier; they are checked again here because this function is the one that moves money.
import { Prisma, type MerchantAccount } from "@prisma/client";
import type Stripe from "stripe";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { notifyError } from "../infra/error-reporting.ts";
import {
  APIConnectionError,
  AuthenticationError,
  InvalidRequestError,
  RateLimitError,
  StripeError,
} from "../stripe/errors.ts";
import { Balance, Charge, Transfer } from "../stripe/resources.ts";

import type { BalanceRecord } from "./balance.ts";
import { jsonDataForAttr, setJsonDataForAttr } from "./concerns/json-data.ts";
import {
  isGumroadManagedStripeAccount,
  MerchantAccounts,
  merchantAccountUser,
  type MerchantAccountRow,
} from "./merchant-account.ts";
import { reverseInternalTransferOrHoldPayoutsBang } from "./payment-hold.ts";
import { markFailedBang, paymentUser, type PaymentRecord } from "./payment.ts";
import { FailureReason, stripeInvalidRequestErrorFailureReason } from "./payout-failure-reason.ts";
import { getPayoutDetails, holdOf, type HeldBalance } from "./payout-reads.ts";
import { PAYOUT_TYPE_INSTANT } from "./payouts.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NoMethodError, NotPortedError, type UserRecord } from "./user.ts";

const PROCESSOR_REF = "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb";
// StripePayoutProcessor::INSTANT_PAYOUT_FEE_PERCENT
const INSTANT_PAYOUT_FEE_PERCENT = 3;
const TRUNCATED_LENGTH = 1000;
// StripeMetadata::STRIPE_METADATA_MAX_KEYS_LENGTH and STRIPE_METADATA_VALUE_MAX_LENGTH
export const STRIPE_METADATA_MAX_KEYS_LENGTH = 50;
const STRIPE_METADATA_VALUE_MAX_LENGTH = 500;
const DESTINATION_CHARGE_ATTEMPTS = 3;
const DESTINATION_CHARGE_RETRY_SECONDS = 2;
const USD = "usd";
const HUF_AND_TWD = ["huf", "twd"];
const KRW = "krw";

// `sleep(2)` between the destination charge lookups; a test replaces it.
let sleeper: (seconds: number) => Promise<void> = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
export const setPrepareSleep = (next: (seconds: number) => Promise<void>) => void (sleeper = next);

// `String#truncate(1000)`: the omission counts toward the limit.
const truncate = (text: string) =>
  text.length <= TRUNCATED_LENGTH ? text : `${text.slice(0, TRUNCATED_LENGTH - 3)}...`;

// StripeMetadata.build_metadata_large_list: items joined into slices of at most 500 characters under `key{index}`. Ruby's
// `[0..max_key_length]` keeps one more than the limit.
export function buildMetadataLargeList(items: string[], key: string, maxKeyLength: number): Record<string, string> {
  const slices: string[] = [];
  for (const item of items) {
    let slice = slices.at(-1);
    if (slice === undefined || slice.length + 1 + item.length > STRIPE_METADATA_VALUE_MAX_LENGTH) {
      slices.push("");
      slice = "";
    }
    const index = slices.length - 1;
    slices[index] = `${slice}${slice === "" ? "" : ","}${item}`;
  }
  return Object.fromEntries(slices.slice(0, maxKeyLength + 1).map((slice, index) => [`${key}{${index}}`, slice]));
}

const holdingCents = (balance: BalanceRecord) => Number(balance.get("holding_amount_cents") ?? 0);
const sumHolding = (held: HeldBalance[]) => held.reduce((total, entry) => total + holdingCents(entry.balance), 0);
const accountOf = (row: MerchantAccountRow) => row as unknown as Record<string, unknown>;
const accountCurrency = (row: MerchantAccountRow) => String(accountOf(row).currency ?? "");
const isActive = (row: MerchantAccountRow) =>
  accountOf(row).deleted_at == null &&
  accountOf(row).charge_processor_alive_at != null &&
  accountOf(row).charge_processor_deleted_at == null;
const stripeAccountId = (row: MerchantAccountRow) => String(accountOf(row).charge_processor_merchant_id ?? "");

// A RuntimeError in Ruby is a bare `raise "..."`; anything with its own class is a StandardError.
const isRuntimeError = (error: unknown) => error instanceof Error && error.constructor === Error;
const errorClass = (error: unknown) => {
  if (error instanceof StripeError) return error.rubyClass;
  if (error instanceof Error) return isRuntimeError(error) ? "RuntimeError" : error.name;
  return "RuntimeError";
};

type StripeBalanceAmounts = {
  available?: { currency: string; amount: number }[] | null;
  pending?: { currency: string; amount: number }[] | null;
};

// `stripe_balance.available`: a StripeObject raises NoMethodError for a key the response left out.
function balanceList(balance: StripeBalanceAmounts, key: "available" | "pending") {
  if (!(key in balance)) throw new NoMethodError(`undefined method '${key}' for an instance of Stripe::Balance`);
  return balance[key] ?? null;
}

// retired_account_balances_hint: names the seller's retired Gumroad-managed accounts that still hold money at Stripe.
async function retiredAccountBalancesHint(merchantAccount: MerchantAccountRow, cachedUser: UserRecord | null) {
  // `merchant_account.user`: a read of its own, unless the account came from `user.merchant_accounts`, whose inverse is the seller.
  const user =
    cachedUser ??
    (await merchantAccountUser(MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", merchantAccount))));
  const merchantAccountId = accountOf(merchantAccount).id;
  const rows = await selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user!.get("id")} AND ${column("merchant_accounts", "charge_processor_id")} = 'stripe' AND ${column("merchant_accounts", "deleted_at")} IS NOT NULL AND ${column("merchant_accounts", "id")} != ${merchantAccountId}`,
  );
  const found: string[] = [];
  for (const retired of rows.filter((row) => isGumroadManagedStripeAccount(row))) {
    try {
      const balance = (await Balance.retrieve({}, { stripeAccount: stripeAccountId(retired) })) as StripeBalanceAmounts;
      const all = [...(balanceList(balance, "available") ?? []), ...(balanceList(balance, "pending") ?? [])];
      const residual = all.reduce((total, entry) => total + Math.max(entry.amount, 0), 0);
      if (residual <= 0) continue;
      const amounts = all
        .filter((entry) => entry.amount > 0)
        .map((entry) => `${entry.amount} ${entry.currency} cents`)
        .join(" + ");
      found.push(`${stripeAccountId(retired)} holds ${amounts}`);
    } catch (error) {
      // The retired account may be gone at Stripe entirely; the hint is best-effort.
      if (!(error instanceof StripeError)) throw error;
    }
  }
  if (found.length === 0) return "";
  return ` Possible cause: the seller has retired Stripe account(s) still holding funds — ${found.join("; ")}. A returned payout may have re-credited a retired account after a country change; move those funds to the active account.`;
}

const negativeBalanceIds = (held: HeldBalance[]) => {
  const negative = held.filter((entry) => holdingCents(entry.balance) < 0);
  if (negative.length === 0) return ["no single balance is negative; the set nets negative"];
  return negative.map((entry) => `Balance ${String(entry.balance.get("id"))}: ${holdingCents(entry.balance)}`);
};

// destination_balance_drift_error: [message, failure reason], or null when the destination is coherent.
async function destinationBalanceDriftError(
  merchantAccount: MerchantAccountRow,
  heldByStripe: HeldBalance[],
  payoutCurrency: string,
  cachedUser: UserRecord | null,
): Promise<[string, string] | null> {
  if (!isGumroadManagedStripeAccount(merchantAccount)) return null;
  if (heldByStripe.length === 0) return null;
  const destinationCurrency = payoutCurrency === "" ? accountCurrency(merchantAccount) : payoutCurrency;
  const expected = sumHolding(heldByStripe);
  const usdLedger = heldByStripe.reduce((total, entry) => total + Number(entry.balance.get("amount_cents") ?? 0), 0);
  const accountId = stripeAccountId(merchantAccount);
  const hint = () => retiredAccountBalancesHint(merchantAccount, cachedUser);

  if (expected < 0 && !(usdLedger < 0)) {
    const message =
      `Destination ledger is negative on ${accountId}: balances held at Stripe sum to ${expected} ${destinationCurrency} cents ` +
      `while their USD ledger reads ${usdLedger} cents, across ${heldByStripe.length} balance${heldByStripe.length === 1 ? "" : "s"} ` +
      `(${negativeBalanceIds(heldByStripe).join(", ")}). Paying out would subtract the difference from the wire amount without it ` +
      `appearing in the seller's balance. Reconcile the destination balance before retry.${await hint()}`;
    return [message, FailureReason.DESTINATION_LEDGER_NEGATIVE];
  }
  if (expected <= 0) return null;
  // Stripe reports KRW in single units while Gumroad stores 100 subunits, so the comparison would always trip.
  if (destinationCurrency === KRW) return null;

  const stripeBalance = (await Balance.retrieve({}, { stripeAccount: accountId })) as StripeBalanceAmounts;
  const available =
    balanceList(stripeBalance, "available")?.find((entry) => entry.currency === destinationCurrency)?.amount ?? 0;
  // Connect balances can report negative `pending`; only incoming settlement is credited.
  const pending = Math.max(
    balanceList(stripeBalance, "pending")?.find((entry) => entry.currency === destinationCurrency)?.amount ?? 0,
    0,
  );
  if (available + pending >= expected) return null;
  const gap = expected - (available + pending);
  const message =
    `Destination Stripe balance mismatch on ${accountId}: expected ${expected} ${destinationCurrency} cents, ` +
    `Stripe has ${available} cents available + ${pending} cents pending (gap: ${gap} cents). ` +
    `Reconcile destination balance before retry.${await hint()}`;
  return [message, FailureReason.INSUFFICIENT_FUNDS];
}

// prepare_payment_and_set_amount(payment, balances, merchant_account, payout_currency): the errors, an empty list when ready.
export async function preparePaymentAndSetAmount(
  payment: PaymentRecord,
  balances: BalanceRecord[],
  merchantAccountArgument: MerchantAccountRow | null,
  payoutCurrencyArgument: string | null,
  options: SaveOptions = {},
  // The account is one the seller's own `merchant_accounts` produced, so its `user` is already loaded.
  accountFromSeller = false,
): Promise<string[]> {
  let failed = false;
  let failureReason: string | null = null;
  let transferRequested = false;
  try {
    const user = (await paymentUser(payment))!;
    const held: HeldBalance[] = [];
    for (const balance of balances) held.push(await holdOf(balance));
    const { merchantAccount: destination, heldByGumroad, heldByStripe } = await getPayoutDetails(user, held);
    // Callers that already grouped the balances pass the group's own account.
    const merchantAccount = merchantAccountArgument ?? destination;

    if (merchantAccount === null) {
      payment.set("bank_account_id", null);
      await markFailedBang(payment, null, options);
      return ["Cannot process payout: no valid merchant account found for user."];
    }
    if (!isActive(merchantAccount))
      throw new NotPortedError(
        "a payout to a retired Stripe account",
        `${PROCESSOR_REF} prepare_payment_and_set_amount`,
      );

    const stripeCurrencies = [
      ...new Set(heldByStripe.map((entry) => String(entry.balance.get("holding_currency") ?? ""))),
    ];
    let payoutCurrency =
      payoutCurrencyArgument !== null && payoutCurrencyArgument.trim() !== "" ? payoutCurrencyArgument : null;
    payoutCurrency ??= stripeCurrencies.length === 1 ? stripeCurrencies[0]! : accountCurrency(merchantAccount);
    if (payoutCurrency !== accountCurrency(merchantAccount)) payment.set("bank_account_id", null);

    // A currency mismatch would turn nominal cents into a different amount of money.
    const mismatchedStripe = heldByStripe.filter(
      (entry) =>
        !(
          String(entry.balance.get("holding_currency") ?? "") === payoutCurrency &&
          String(entry.balance.get("merchant_account_id")) === String(accountOf(merchantAccount).id)
        ),
    );
    const matchedStripe = heldByStripe.filter((entry) => !mismatchedStripe.includes(entry));
    if (
      matchedStripe.some(
        (entry) => String(entry.balance.get("holding_currency") ?? "") !== accountCurrency(merchantAccount),
      )
    )
      throw new NotPortedError("a payable-currency probe", `${PROCESSOR_REF} pay_out_currencies`);
    let mismatchedGumroad = heldByGumroad.filter(
      (entry) => String(entry.balance.get("holding_currency") ?? "") !== USD,
    );
    if (heldByGumroad.length > 0 && payoutCurrency !== accountCurrency(merchantAccount))
      mismatchedGumroad = [...mismatchedGumroad, ...heldByGumroad];
    if (mismatchedStripe.length > 0 || mismatchedGumroad.length > 0) {
      const ids = [...mismatchedStripe, ...mismatchedGumroad].map((entry) => String(entry.balance.get("id")));
      const message = `Cannot process payout: balances [${ids.join(", ")}] have holding_currency that does not match the payout currency.`;
      setJsonDataForAttr(payment, "error_message", truncate(message));
      await markFailedBang(payment, FailureReason.CURRENCY_MISMATCH, options);
      return [message];
    }

    payment.set("stripe_connect_account_id", stripeAccountId(merchantAccount));
    payment.set("currency", payoutCurrency);
    payment.set("amount_cents", 0n);

    const drift = await destinationBalanceDriftError(
      merchantAccount,
      heldByStripe,
      payoutCurrency,
      accountFromSeller ? user : null,
    );
    if (drift !== null) {
      const [message, reason] = drift;
      setJsonDataForAttr(payment, "error_message", truncate(message));
      await markFailedBang(payment, reason, options);
      payment.errors.add("base", message);
      return [message];
    }

    let amountCents = sumHolding(heldByStripe);

    // Funds held by Gumroad reach the seller's connected account as an internal transfer.
    const amountHeldByGumroad = sumHolding(heldByGumroad);
    if (amountHeldByGumroad > 0) {
      const paymentExternalId = encrypt(payment.get("id"));
      // Past this point Stripe may have accepted the transfer even if the response never arrives.
      transferRequested = true;
      const transfer = await Transfer.create({
        destination: String(payment.get("stripe_connect_account_id")),
        currency: USD,
        description: `Funds held by Gumroad for Payment ${paymentExternalId}.`,
        amount: amountHeldByGumroad,
        metadata: {
          payment: paymentExternalId,
          ...buildMetadataLargeList(
            heldByGumroad.map((entry) => encrypt(entry.balance.get("id"))),
            "balances",
            STRIPE_METADATA_MAX_KEYS_LENGTH - 1,
          ),
        },
        expand: ["balance_transaction"],
      });
      // Recorded before anything else can fail: the reversal keys off this field.
      payment.set("stripe_internal_transfer_id", transfer.id);
      let destinationPayment: Stripe.Charge | null = null;
      for (let attempt = 0; attempt < DESTINATION_CHARGE_ATTEMPTS; attempt += 1) {
        destinationPayment = await Charge.retrieve(
          { id: transfer.destination_payment as string, expand: ["balance_transaction"] },
          { stripeAccount: String(payment.get("stripe_connect_account_id")) },
        );
        if (destinationPayment.balance_transaction != null) break;
        if (attempt === DESTINATION_CHARGE_ATTEMPTS - 1)
          throw new Error(`Balance transaction not yet available for destination payment ${destinationPayment.id}`);
        await sleeper(DESTINATION_CHARGE_RETRY_SECONDS);
      }
      const balanceTransaction = destinationPayment?.balance_transaction;
      if (balanceTransaction == null || typeof balanceTransaction !== "object")
        throw new NoMethodError("undefined method 'amount' for a String");
      amountCents += balanceTransaction.amount;
    }
    // Stripe only takes HUF and TWD payouts divisible by 100; the whole amount is still marked paid on our side.
    if (HUF_AND_TWD.includes(payoutCurrency)) amountCents -= amountCents % 100;
    // Gumroad stores KRW with 100 subunits; Stripe treats it as a single-unit currency.
    if (payoutCurrency === KRW) amountCents *= 100;
    // For instant payouts, the amount has to be net of instant payout fees.
    if (jsonDataForAttr(payment, "payout_type") === PAYOUT_TYPE_INSTANT)
      amountCents = Math.floor((amountCents * 100.0) / (100 + INSTANT_PAYOUT_FEE_PERCENT));
    payment.set("amount_cents", BigInt(amountCents));
    return [];
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      failed = true;
      setJsonDataForAttr(payment, "error_message", truncate(error.message));
      failureReason = stripeInvalidRequestErrorFailureReason(error);
      // A known account-state failure drives the "cannot pay" email; reporting each one only adds noise.
      if (failureReason === null) notifyError(error);
      return [error.message];
    }
    if (error instanceof AuthenticationError || error instanceof APIConnectionError) {
      failed = true;
      // A dropped connection around the transfer, with no transfer id, leaves it unknown whether Stripe moved the money.
      failureReason =
        transferRequested && payment.get("stripe_internal_transfer_id") == null
          ? FailureReason.PAYOUT_OUTCOME_UNKNOWN
          : FailureReason.PROCESSOR_UNAVAILABLE;
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
    if (error instanceof NotPortedError) throw error;
    failed = true;
    failureReason = isRuntimeError(error)
      ? FailureReason.PROCESSOR_UNAVAILABLE
      : transferRequested && payment.get("stripe_internal_transfer_id") == null
        ? FailureReason.PAYOUT_OUTCOME_UNKNOWN
        : FailureReason.PROCESSOR_UNAVAILABLE;
    setJsonDataForAttr(
      payment,
      "error_message",
      truncate(`${errorClass(error)}: ${error instanceof Error ? error.message : String(error)}`),
    );
    throw error;
  } finally {
    if (failed) {
      await markFailedBang(payment, failureReason, options);
      await reverseInternalTransferOrHoldPayoutsBang(payment, failureReason, options);
    }
  }
}
