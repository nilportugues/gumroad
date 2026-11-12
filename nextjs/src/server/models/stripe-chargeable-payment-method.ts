// StripeChargeablePaymentMethod (stripe_chargeable_payment_method.rb) for a payment method on Gumroad's own Stripe account: the one
// `GET /v1/payment_methods/:id` that `prepare!` makes and the card facts the purchase and the charge store from its answer.
// A seller's connected account needs the payment method cloned onto it (a Customer create and a PaymentMethod create), which no
// recording covers, so it is refused before the GET.
// Golden: __fixtures__/purchase-paid-order.golden.json, the GET and the `UPDATE purchases` that follows it.
import { withStripeErrorHandler } from "../stripe/charge-processor-errors.ts";
import type { RequestOptions } from "../stripe/client.ts";
import { PaymentMethod } from "../stripe/resources.ts";

import { paymentMethodCardType } from "./purchase-charge-facts.ts";
import { cardNumberLength } from "./stripe-charge-facts.ts";
import type { PaymentMethodChargeable } from "./stripe-payment-intent-request.ts";
import { NotPortedError } from "./user.ts";

type Json = Record<string, unknown>;

// ChargeableVisual::LENGTH_TO_FORMAT
const VISUAL_FORMATS: Record<number, string> = { 15: "**** ****** *%s", 14: "**** ****** %s" };
const DEFAULT_VISUAL_FORMAT = "**** **** **** %s";

const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const cardOf = (paymentMethod: Json): Json | null => {
  const card = paymentMethod.card;
  return typeof card === "object" && card !== null && Object.keys(card).length > 0 ? (card as Json) : null;
};

// ChargeableVisual.build_visual: the last four digits (left padded with `*`) in the format of the card number's length
export function buildVisual(last4: string, length: number): string {
  const digits = last4.replaceAll(/\D/gu, "").padStart(4, "*").slice(-4);
  return (VISUAL_FORMATS[length] ?? DEFAULT_VISUAL_FORMAT).replace("%s", digits);
}

export type PaymentMethodInput = {
  paymentMethodId: string;
  customerId?: string | null;
  // `merchant_account.is_a_stripe_connect_account?` of the product's seller
  isStripeConnect: boolean;
};

// Refuses what `prepare!` would do beyond the one GET, before it makes any call.
export function assertPaymentMethodServable(input: Pick<PaymentMethodInput, "isStripeConnect">): void {
  if (input.isStripeConnect)
    throw new NotPortedError(
      "StripeChargeablePaymentMethod#prepare! for a Stripe Connect seller",
      "no recording clones the payment method",
    );
}

export class StripeChargeablePaymentMethod {
  readonly paymentMethodId: string;
  readonly paymentMethod: Json;
  readonly customerId: string | null;

  private constructor(paymentMethodId: string, paymentMethod: Json, customerId: string | null) {
    this.paymentMethodId = paymentMethodId;
    this.paymentMethod = paymentMethod;
    this.customerId = customerId;
  }

  // `prepare!`: `@customer_id ||= @payment_method.customer`
  static async prepare(input: PaymentMethodInput, options: Pick<RequestOptions, "client"> = {}) {
    assertPaymentMethodServable(input);
    const paymentMethod = (await withStripeErrorHandler(() =>
      PaymentMethod.retrieve(input.paymentMethodId, options),
    )) as unknown as Json;
    const customer = paymentMethod.customer;
    const fromMethod = typeof customer === "string" ? customer : ((customer as Json | null)?.id as string | undefined);
    return new StripeChargeablePaymentMethod(
      input.paymentMethodId,
      paymentMethod,
      present(input.customerId) ? input.customerId : (fromMethod ?? null),
    );
  }

  private get card(): Json | null {
    return cardOf(this.paymentMethod);
  }

  private cardString(name: string): string | null {
    const value = this.card?.[name];
    return present(value) ? value : null;
  }

  get fingerprint() {
    return this.cardString("fingerprint");
  }
  get fundingType() {
    return this.cardString("funding");
  }
  get last4() {
    return this.cardString("last4");
  }
  get country() {
    return this.cardString("country");
  }
  get expiryMonth(): number | null {
    const value = this.card?.exp_month;
    return typeof value === "number" ? value : null;
  }
  get expiryYear(): number | null {
    const value = this.card?.exp_year;
    return typeof value === "number" ? value : null;
  }

  // `card_type`: the brand, else the method's own type when it maps to a known card type
  get cardType(): string | null {
    return paymentMethodCardType({
      brand: this.cardString("brand"),
      methodType: typeof this.paymentMethod.type === "string" ? this.paymentMethod.type : null,
    });
  }

  get numberLength(): number | null {
    return this.cardType === null ? null : cardNumberLength(this.cardType);
  }

  get visual(): string | null {
    return this.last4 !== null && this.numberLength !== null ? buildVisual(this.last4, this.numberLength) : null;
  }

  // `zip_code`: the billing postal code of the payment method once it is fetched
  get zipCode(): string | null {
    const billing = this.paymentMethod.billing_details as { address?: { postal_code?: unknown } } | null;
    const zip = billing?.address?.postal_code;
    return present(zip) ? zip : null;
  }

  // `requires_mandate?`
  get requiresMandate() {
    return this.country === "IN";
  }

  // What PaymentIntent create needs of it (`stripe_charge_params` for an account that is not a Connect one)
  toIntentChargeable(): PaymentMethodChargeable {
    return {
      kind: "payment_method",
      paymentMethodId: this.paymentMethodId,
      customerId: this.customerId,
      paymentMethodIdOnConnectAccount: null,
      customerIdOnConnectAccount: null,
      country: this.country,
      validatedMandateId: null,
    };
  }
}
