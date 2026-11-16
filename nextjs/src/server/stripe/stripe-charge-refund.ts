// Port of app/business/payments/charging/implementations/stripe/stripe_charge_refund.rb: the FlowOfFunds of a refund, from the
// objects `StripeChargeProcessor#get_refund` reads back (the refund and its expanded balance transaction, the charge with its
// application fee, and for a destination charge the destination payment's refund, fee refund and their balance transactions).
// Golden: __fixtures__/flow-of-funds.golden.json (nextjs/scripts/golden/flow-of-funds.rb).
import type { FlowAmount, FlowOfFunds } from "../models/flow-of-funds.ts";

type StripeBalanceTransaction = { id?: string; amount: number; currency: string };

export type StripeChargeRefundInput = {
  charge: {
    destination?: unknown;
    on_behalf_of?: unknown;
    // The expanded fee object; an id that was not expanded is a String, which Ruby cannot ask for an `account`.
    application_fee?: string | { account?: unknown } | null;
  };
  refund: { id: string; charge: string; amount: number; currency: string };
  destination_payment_refund?: { amount: number } | null;
  refund_bt: StripeBalanceTransaction;
  fee_refund_bt?: StripeBalanceTransaction | null;
  destination_refund_bt?: StripeBalanceTransaction | null;
  destination_fee_refund?: { id: string; amount: number; currency: string } | null;
  uncredited?: boolean;
  merchant_account_currency?: string | null;
};

export type StripeChargeRefund = { id: string; chargeId: string; flowOfFunds: FlowOfFunds };

// Ruby truthiness: only nil and false are falsy ("" and 0 are not).
const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;
// Object#present?
const present = (value: unknown) => truthy(value) && !(typeof value === "string" && value.trim() === "");

const amount = (currency: string, cents: number): FlowAmount => ({ currency, cents });

export function stripeChargeRefund(input: StripeChargeRefundInput): StripeChargeRefund {
  const { charge, refund } = input;
  const feeRefundBt = input.fee_refund_bt ?? null;
  const destinationRefundBt = input.destination_refund_bt ?? null;
  const destinationFeeRefund = input.destination_fee_refund ?? null;
  const shouldRefundApplicationFees = feeRefundBt !== null && destinationFeeRefund !== null;
  const hasDestination = truthy(charge.destination) && destinationRefundBt !== null;
  const issuedAmount = amount(refund.currency, -1 * refund.amount);
  const settledAmount = amount(input.refund_bt.currency, input.refund_bt.amount);
  const done = (flowOfFunds: FlowOfFunds): StripeChargeRefund => ({
    id: refund.id,
    chargeId: refund.charge,
    flowOfFunds,
  });

  // A destination payment Stripe never credited must reverse to zero in the account's own currency, to land on the balance row its credit did.
  if (input.uncredited === true && present(charge.destination) && present(input.merchant_account_currency)) {
    const zero = amount(input.merchant_account_currency!, 0);
    return done({
      issuedAmount,
      settledAmount,
      gumroadAmount: amount(refund.currency, -1 * refund.amount),
      merchantAccountGrossAmount: zero,
      merchantAccountNetAmount: zero,
    });
  }

  let gumroadAmount: FlowAmount | null = null;
  let grossAmount: FlowAmount | null = null;
  let netAmount: FlowAmount | null = null;
  if (hasDestination && shouldRefundApplicationFees) {
    if (destinationRefundBt!.currency !== destinationFeeRefund!.currency) {
      throw new Error(
        `Destination Payment Application Fee Refund ${destinationFeeRefund!.id} should be in the same currency as the Destination Payment Refund's Balance Transaction ${destinationRefundBt!.id}`,
      );
    }
    gumroadAmount = amount(feeRefundBt!.currency, feeRefundBt!.amount);
    grossAmount = amount(destinationRefundBt!.currency, destinationRefundBt!.amount);
    netAmount = amount(destinationRefundBt!.currency, destinationRefundBt!.amount + destinationFeeRefund!.amount);
  } else if (hasDestination) {
    if (!truthy(charge.on_behalf_of)) {
      gumroadAmount = amount(refund.currency, refund.amount - input.destination_payment_refund!.amount);
    }
    grossAmount = amount(destinationRefundBt!.currency, destinationRefundBt!.amount);
    netAmount = grossAmount;
  } else if (typeof charge.application_fee === "string") {
    throw new TypeError("undefined method 'account' for an instance of String");
  } else if (present(charge.application_fee?.account)) {
    gumroadAmount = amount(refund.currency, -1 * refund.amount);
  } else {
    gumroadAmount = settledAmount;
  }
  return done({
    issuedAmount,
    settledAmount,
    gumroadAmount,
    merchantAccountGrossAmount: grossAmount,
    merchantAccountNetAmount: netAmount,
  });
}
