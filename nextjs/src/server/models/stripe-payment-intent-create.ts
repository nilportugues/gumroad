// ChargeProcessor.create_payment_intent_or_charge! for a card payment method on Gumroad's own Stripe account
// (StripeChargeProcessor#create_payment_intent_or_charge!): create the PaymentIntent, confirm it when it comes back
// `requires_confirmation`, and for a succeeded one read the charge with its balance transaction (StripeChargeIntent#load_charge).
// Every Stripe error leaves as the ChargeProcessor error `with_stripe_error_handler` makes of it.
// Golden: __fixtures__/purchase-paid-order.golden.json, the Stripe calls of the $5 sale, the declines, the lost answers, 3DS and
// processing. The request bodies come from stripe-payment-intent-request.ts.
//
// Anything the golden does not cover is refused by assertPaymentIntentServable BEFORE the first call. After the create nothing may
// throw for a shape Node does not know: the intent exists at Stripe, so such a case returns with `chargeUnreadable` set instead.
import { chargeProcessorError, ChargeProcessorUnavailableError } from "../stripe/charge-processor-errors.ts";
import type { RequestOptions } from "../stripe/client.ts";
import { Charge, PaymentIntent } from "../stripe/resources.ts";

import { paymentIntentOutcome, type IntentOutcome } from "./payment-intent-response.ts";
import { readStripeCharge, type ProcessorCharge } from "./stripe-charge-facts.ts";
import { buildPaymentIntentRequests, type PaymentIntentRequestInput } from "./stripe-payment-intent-request.ts";
import { NotPortedError } from "./user.ts";

type Json = Record<string, unknown>;

export const REQUIRES_CONFIRMATION = "requires_confirmation";
// StripeChargeProcessor#get_charge's `expand`
const CHARGE_EXPANSIONS = ["balance_transaction", "application_fee.balance_transaction"];

export type ChargeIntent = {
  id: string;
  clientSecret: string | null;
  status: string;
  outcome: IntentOutcome;
  paymentMethodId: string | null;
  // set for a succeeded intent whose charge could be read
  charge: ProcessorCharge | null;
  // set when the intent succeeded but its charge is not in a shape this port reads (`balance_transaction` not expanded)
  chargeUnreadable: string | null;
};

const notPorted = (what: string) =>
  new NotPortedError(`Charge::CreateService with ${what}`, "stripe_charge_processor.rb");

// What create_payment_intent_or_charge! can do beyond the recorded card payment on the platform account.
export function assertPaymentIntentServable(input: PaymentIntentRequestInput): void {
  const refuse = (condition: boolean, what: string) => {
    if (condition) throw notPorted(what);
  };
  refuse(input.merchant.kind !== "platform", "a seller's own Stripe account (a direct or destination charge)");
  refuse(input.chargeable.kind !== "payment_method", "a UPI payment method");
  refuse(input.chargeable.kind === "payment_method" && input.chargeable.country === "IN", "an Indian card");
  refuse(input.offSession, "an off-session charge");
  refuse(input.setupFutureCharges, "a charge that saves the card");
  refuse(input.mandateOptions !== null && Object.keys(input.mandateOptions).length > 0, "mandate options");
  refuse(input.mandateExpected, "an expected mandate");
  refuse(input.stripeFxQuoteId !== null, "a buyer-currency quote");
  refuse(
    input.processorAmountCents !== null ||
      input.processorCurrency !== null ||
      input.processorGumroadAmountCents !== null,
    "a buyer-currency presentment",
  );
  refuse(input.idempotencyKey !== null, "an explicit idempotency key");
}

const objectId = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  const id = (value as Json | null)?.id;
  return typeof id === "string" ? id : null;
};

// StripeChargeIntent#load_charge, then StripeChargeProcessor#get_charge_object for a charge on the platform account.
async function loadCharge(
  intent: Json,
  options: Pick<RequestOptions, "client">,
  now: Date,
): Promise<{ charge: ProcessorCharge | null; unreadable: string | null }> {
  const charges = (intent.charges as { data?: Json[] } | undefined)?.data;
  const chargeId = objectId(intent.latest_charge) ?? objectId(charges?.[0]);
  if (chargeId === null) throw new Error(`Expected a charge for payment intent ${String(intent.id)}, but got nil`);

  const charge = (await Charge.retrieve({ id: chargeId, expand: CHARGE_EXPANSIONS }, options)) as unknown as Json;
  const transfer = charge.transfer;
  if (charge.transfer_data && transfer) return { charge: null, unreadable: "destination charge" };
  const balanceTransaction = charge.balance_transaction;
  if (typeof balanceTransaction === "string" || balanceTransaction === undefined)
    return { charge: null, unreadable: "balance_transaction not expanded" };
  const applicationFee = charge.application_fee as Json | null | undefined;
  return {
    charge: readStripeCharge({
      charge,
      balanceTransaction: balanceTransaction as Json | null,
      applicationFeeBalanceTransaction: (applicationFee?.balance_transaction as Json | null | undefined) ?? null,
      destinationPaymentBalanceTransaction: null,
      destinationTransfer: null,
      now,
    }),
    unreadable: null,
  };
}

export async function createPaymentIntentOrCharge(
  input: PaymentIntentRequestInput,
  options: Pick<RequestOptions, "client"> & { now: Date },
): Promise<ChargeIntent> {
  assertPaymentIntentServable(input);
  const built = buildPaymentIntentRequests(input);
  if (!built.ok) throw new Error(`Refused before any call: ${built.refusal.message}`);
  const { plan } = built;
  const stripeOptions: RequestOptions = { client: options.client };

  let createdId: string | null = null;
  try {
    let intent = (await PaymentIntent.create(plan.create.params as never, stripeOptions)) as unknown as Json;
    createdId = objectId(intent);
    if (intent.status === REQUIRES_CONFIRMATION)
      intent = (await PaymentIntent.confirm(createdId, {}, stripeOptions)) as unknown as Json;

    const outcome = paymentIntentOutcome(intent as never);
    const result: ChargeIntent = {
      id: createdId!,
      clientSecret: typeof intent.client_secret === "string" ? intent.client_secret : null,
      status: intent.status as string,
      outcome,
      paymentMethodId: objectId(intent.payment_method),
      charge: null,
      chargeUnreadable: null,
    };
    if (outcome === "succeeded") {
      const loaded = await loadCharge(intent, stripeOptions, options.now);
      result.charge = loaded.charge;
      result.chargeUnreadable = loaded.unreadable;
    }
    return result;
  } catch (error) {
    const mapped = chargeProcessorError(error);
    if (mapped instanceof ChargeProcessorUnavailableError) mapped.lostIntentId = createdId;
    throw mapped;
  }
}
