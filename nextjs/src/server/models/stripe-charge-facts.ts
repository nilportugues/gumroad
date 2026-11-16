// What `StripeCharge` (app/business/payments/charging/implementations/stripe/stripe_charge.rb) reads off a Stripe charge and its
// balance transactions once the charge exists: the processor fee, the flow of funds and the card details that
// `Purchase#save_charge_data` stores. Pure over the JSON Stripe returned (the `GET /v1/charges/:id` the checkout expands with
// `application_fee.balance_transaction` and `balance_transaction`), so a Node checkout can read the answer of its fourth call
// without a Stripe client.
// Golden: __fixtures__/stripe-charge-facts.golden.json (scripts/golden/stripe-charge-facts.rb), from the real StripeCharge.
import { paymentMethodCardType } from "./purchase-charge-facts.ts";

// Past this, a succeeded destination payment with no balance transaction never gets one.
export const DESTINATION_PAYMENT_SETTLEMENT_GRACE_SECONDS = 24 * 60 * 60;

type Json = Record<string, unknown>;
export type FlowAmount = { currency: string; cents: number };
export type FlowOfFunds = {
  issuedAmount: FlowAmount;
  settledAmount: FlowAmount;
  gumroadAmount: FlowAmount;
  merchantAccountGrossAmount: FlowAmount | null;
  merchantAccountNetAmount: FlowAmount | null;
};

export type StripeChargeInput = {
  charge: Json;
  balanceTransaction: Json | null;
  applicationFeeBalanceTransaction: Json | null;
  destinationPaymentBalanceTransaction: Json | null;
  destinationTransfer: Json | null;
  destinationPayment?: Json | null;
  // the destination account's currency, not the charge's
  merchantAccountCurrency?: string | null;
  now: Date;
};

export type ProcessorCharge = {
  id: string;
  status: string;
  refunded: boolean;
  disputed: boolean;
  amountCents: number;
  currency: string;
  amountRefundedCents: number;
  fee: number | null;
  feeCurrency: string | null;
  flowOfFunds: FlowOfFunds | null;
  cardFingerprint: string | null;
  cardInstanceId: string | null;
  cardLast4: string | null;
  cardNumberLength: number | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  cardZipCode: string | null;
  cardType: string | null;
  cardCountry: string | null;
  zipCheckResult: boolean | null;
  riskLevel: string | null;
  cardMandate: string | null;
  paymentMethodType: string | null;
};

// CreditCardUtility::CARD_TYPE_DEFAULT_LENGTHS, keyed by CardType
const CARD_NUMBER_LENGTHS: Record<string, number> = {
  generic_card: 16,
  visa: 16,
  amex: 15,
  mastercard: 16,
  discover: 16,
  jcb: 16,
  diners: 14,
  unionpay: 16,
};
const UNKNOWN_CARD_NUMBER_LENGTH = 16;
export const cardNumberLength = (cardType: string): number =>
  CARD_NUMBER_LENGTHS[cardType] ?? UNKNOWN_CARD_NUMBER_LENGTH;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const obj = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
// Ruby truthiness for a Stripe field: only nil and false are falsy.
const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;
// Object#present?
const rubyPresent = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};
const presentString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function destinationPaymentPermanentlyUncredited(
  destinationPayment: Json | null | undefined,
  merchantAccountCurrency: string | null | undefined,
  now: Date,
): boolean {
  if (!destinationPayment || !presentString(merchantAccountCurrency)) return false;
  if (destinationPayment.status !== "succeeded" || !truthy(destinationPayment.captured)) return false;
  const created = num(destinationPayment.created);
  if (created === null) return false;
  return created * 1000 <= now.getTime() - DESTINATION_PAYMENT_SETTLEMENT_GRACE_SECONDS * 1000;
}

const amountOf = (currency: unknown, cents: unknown): FlowAmount => ({
  currency: currency as string,
  cents: cents as number,
});

// StripeCharge#build_flow_of_funds
function buildFlowOfFunds(input: StripeChargeInput, balanceTransaction: Json): FlowOfFunds | null {
  const { charge } = input;
  const applicationFee = input.applicationFeeBalanceTransaction;
  const destinationPaymentBt = input.destinationPaymentBalanceTransaction;
  const transfer = input.destinationTransfer;
  const destination = truthy(charge.destination);

  if (destination) {
    if (applicationFee === null && transfer === null) return null;
    if (
      destinationPaymentBt === null &&
      !destinationPaymentPermanentlyUncredited(input.destinationPayment, input.merchantAccountCurrency, input.now)
    )
      return null;
  }

  const issuedAmount = amountOf(charge.currency, charge.amount);
  const settledAmount = amountOf(balanceTransaction.currency, balanceTransaction.amount);

  if (destination) {
    const gumroadAmount = applicationFee
      ? amountOf(applicationFee.currency, applicationFee.amount)
      : amountOf(charge.currency, (charge.amount as number) - (transfer!.amount as number));
    if (destinationPaymentBt) {
      return {
        issuedAmount,
        settledAmount,
        gumroadAmount,
        merchantAccountGrossAmount: amountOf(destinationPaymentBt.currency, destinationPaymentBt.amount),
        merchantAccountNetAmount: amountOf(destinationPaymentBt.currency, destinationPaymentBt.net),
      };
    }
    // Stripe accepted the destination payment but never credited the account: record what it received, nothing, in its currency.
    const zero = amountOf(input.merchantAccountCurrency, 0);
    return {
      issuedAmount,
      settledAmount,
      gumroadAmount,
      merchantAccountGrossAmount: zero,
      merchantAccountNetAmount: { ...zero },
    };
  }
  if (applicationFee) {
    // a direct charge on a connected account
    return {
      issuedAmount,
      settledAmount,
      gumroadAmount: amountOf(applicationFee.currency, applicationFee.amount),
      merchantAccountGrossAmount: amountOf(balanceTransaction.currency, balanceTransaction.amount),
      merchantAccountNetAmount: amountOf(balanceTransaction.currency, balanceTransaction.net),
    };
  }
  return {
    issuedAmount,
    settledAmount,
    gumroadAmount: settledAmount,
    merchantAccountGrossAmount: null,
    merchantAccountNetAmount: null,
  };
}

// StripeCharge#fetch_card_details_from
function applyCardDetails(result: ProcessorCharge, charge: Json): void {
  const details = obj(charge.payment_method_details)!;
  const billing = obj(charge.billing_details);
  const card = obj(details.card);
  result.cardInstanceId = str(charge.payment_method);
  result.paymentMethodType = str(details.type);
  const billingZip = str(obj(billing?.address)?.postal_code);

  if (card === null) {
    const methodType = str(details.type);
    // StripeCardType.to_new_card_type: an unmapped method is the generic card type
    result.cardType = paymentMethodCardType({ brand: methodType, methodType: null }) ?? "generic_card";
    result.cardCountry = methodType !== null && methodType !== "" ? str(obj(details[methodType])?.country) : null;
    if (billing !== null) result.cardZipCode = billingZip;
    result.cardFingerprint = str(charge.payment_method);
    return;
  }

  result.cardFingerprint = str(card.fingerprint);
  result.cardLast4 = str(card.last4);
  if (presentString(card.brand)) {
    result.cardType = paymentMethodCardType({ brand: card.brand, methodType: null });
    result.cardNumberLength = cardNumberLength(result.cardType ?? "generic_card");
  }
  result.cardExpiryMonth = num(card.exp_month);
  result.cardExpiryYear = num(card.exp_year);
  result.cardMandate = str(card.mandate);
  result.cardZipCode = billingZip;
  result.cardCountry = str(card.country);
  const check = str(obj(card.checks)?.address_postal_code_check);
  result.zipCheckResult = check === "pass" ? true : check === "fail" ? false : null;
}

// StripeCharge.new(...)
export function readStripeCharge(input: StripeChargeInput): ProcessorCharge {
  const { charge } = input;
  const result: ProcessorCharge = {
    id: charge.id as string,
    status: String(charge.status ?? "").toLowerCase(),
    refunded: charge.refunded as boolean,
    disputed: rubyPresent(charge.dispute),
    amountCents: charge.amount as number,
    currency: charge.currency as string,
    amountRefundedCents: charge.amount_refunded as number,
    fee: null,
    feeCurrency: null,
    flowOfFunds: null,
    cardFingerprint: null,
    cardInstanceId: null,
    cardLast4: null,
    cardNumberLength: null,
    cardExpiryMonth: null,
    cardExpiryYear: null,
    cardZipCode: null,
    cardType: null,
    cardCountry: null,
    zipCheckResult: null,
    riskLevel: null,
    cardMandate: null,
    paymentMethodType: null,
  };

  const bt = input.balanceTransaction;
  if (bt !== null) {
    const feeDetails = Array.isArray(bt.fee_details) ? (bt.fee_details as Json[]) : [];
    const stripeFee = feeDetails.find((detail) => detail.type === "stripe_fee");
    if (stripeFee) {
      result.feeCurrency = str(stripeFee.currency);
      result.fee = num(stripeFee.amount);
    }
    result.flowOfFunds = buildFlowOfFunds(input, bt);
  }

  if (charge.payment_method_details === null || charge.payment_method_details === undefined) return result;
  result.riskLevel = str(obj(charge.outcome)?.risk_level);
  applyCardDetails(result, charge);
  return result;
}
