// The requests `StripeChargeProcessor#create_payment_intent_or_charge!` sends to Stripe, built without sending them: the
// PaymentIntent create and, for an intent that comes back `requires_confirmation`, the confirm. It carries every branch of a paid
// checkout: future usage, off-session confirmation, Indian card mandates, UPI Autopay, a buyer-currency quote, direct and
// destination charges, and the statement descriptor suffix.
//
// Nothing here calls Stripe or reads a record. A caller resolves the two lookups the mandate branch needs (`mandateLookups`)
// before building, and sends the requests itself. Everything Ruby refuses before any call is returned as a `refusal`, never
// thrown, so a failure here cannot happen after a request went out.
// Golden: __fixtures__/stripe-payment-intent-request.golden.json (scripts/golden/stripe-payment-intent-request.rb), the requests the
// real method sent through WebMock.
export const STRIPE_API_VERSION = "2023-10-16";
// StripeFxQuote::API_VERSION
export const STRIPE_FX_QUOTE_API_VERSION = "2025-07-30.preview";
export const UPI_PAYMENT_METHOD_TYPE = "upi";
// Checkout::PaymentMethodResolver::UPI_RECURRING_MAX_INR_CENTS
export const UPI_RECURRING_MAX_INR_CENTS = 1_500_000;
export const STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH = 22;

export const UPI_PAYMENT_METHOD_UPDATE_MESSAGE =
  "Your saved UPI payment method can no longer be used. Please update your payment method to continue your membership.";
export const SELLER_PROCEEDS_ERROR_MESSAGE =
  "The purchase total is too small for us to process. Please add another item to your order or contact the creator.";
export const INDIA_CARD_MANDATE_MISSING_MESSAGE =
  "Your card's recurring payment authorization is missing. Please re-enter your payment method to complete this payment.";
export const UPI_RECURRING_AUTHORIZATION_REQUIRED = "upi_recurring_authorization_required";
export const NET_NEGATIVE_SELLER_REVENUE = "net_negative_seller_revenue";
export const INDIA_CARD_MANDATE_MISSING = "india_card_mandate_missing";

type Scalar = string | number | boolean | null | undefined;
export type StripeParams = { [key: string]: Scalar | StripeParams | StripeParams[] | Scalar[] };

export type MerchantAccountKind =
  // the shared Gumroad account: Gumroad keeps everything
  | { kind: "platform" }
  // a Gumroad-managed account of the seller: a destination charge with a transfer
  | { kind: "destination"; chargeProcessorMerchantId: string | null }
  // the seller's own connected account: a direct charge with an application fee
  | { kind: "direct"; chargeProcessorMerchantId: string | null };

export type PaymentMethodChargeable = {
  kind: "payment_method";
  paymentMethodId: string | null;
  customerId: string | null;
  // the same two, as attached to the seller's connected account for a direct charge
  paymentMethodIdOnConnectAccount: string | null;
  customerIdOnConnectAccount: string | null;
  // the card's country: an Indian card requires a mandate
  country: string | null;
  // a mandate already validated for this checkout
  validatedMandateId: string | null;
};

export type UpiChargeable = {
  kind: "upi";
  customerId: string | null;
  paymentMethodId: string | null;
  recurringAuthorizationVerified: boolean;
  recurringAuthorizationCurrency: string | null;
  recurringAuthorizationMaxAmountCents: number | null;
};

export type PaymentIntentRequestInput = {
  merchant: MerchantAccountKind;
  chargeable: PaymentMethodChargeable | UpiChargeable;
  amountCents: number;
  amountForGumroadCents: number;
  reference: string;
  description: string | null;
  // nil in Ruby means `{ purchase: reference }`
  metadata: Record<string, string> | null;
  statementDescription: string | null;
  transferGroup: string | null;
  offSession: boolean;
  setupFutureCharges: boolean;
  mandateOptions: StripeParams | null;
  mandateExpected: boolean;
  // `get_mandate_id_from_chargeable`'s answer, when `mandateLookups(...).lookup` said it is needed
  resolvedMandateId: string | null;
  // Feature.active?(:fail_india_recurring_charge_without_mandate)
  failFastWithoutMandate: boolean;
  processorAmountCents: number | null;
  processorCurrency: string | null;
  processorGumroadAmountCents: number | null;
  stripeFxQuoteId: string | null;
  idempotencyKey: string | null;
};

export type StripeRequest = {
  method: "POST";
  path: string;
  headers: Record<string, string>;
  body: string;
  // Only the create has a caller-chosen key; the confirm (and a create without one) takes a fresh random key per attempt, which the
  // caller generates and reuses on a retry of the same call.
  idempotencyKey: "explicit" | "generated";
};

export type Refusal = { className: "ChargeProcessorCardError" | "RuntimeError"; message: string; code: string | null };

export type PaymentIntentRequestPlan = {
  create: StripeRequest;
  // POSTed when the created intent is `requires_confirmation`; the path's `pi_ID` is the created intent's id.
  confirm: StripeRequest;
  // ErrorNotifier.notify calls Ruby made while building
  notifications: number;
};

export type PaymentIntentRequestResult =
  | { ok: true; plan: PaymentIntentRequestPlan }
  | { ok: false; refusal: Refusal; notifications: number };

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// Which of the mandate branch's two calls the caller has to make before building. `lookup` reads the mandate behind the chargeable's
// setup or payment intent (a payment method chargeable always takes this path, whatever `mandate_options` holds); `pendingCheck`
// then asks Stripe whether a mandate that came back is active yet, and applies unless the charge is a rebill (`mandateExpected`).
export function mandateLookups(
  input: Pick<PaymentIntentRequestInput, "chargeable" | "offSession" | "mandateExpected">,
  resolvedMandateId: string | null,
): { lookup: boolean; pendingCheck: boolean } {
  const { chargeable } = input;
  const lookup =
    chargeable.kind === "payment_method" &&
    input.offSession &&
    chargeable.country === "IN" &&
    !present(chargeable.validatedMandateId);
  return { lookup, pendingCheck: lookup && present(resolvedMandateId) && !input.mandateExpected };
}

function isBlankParams(value: StripeParams | null): boolean {
  return value === null || Object.keys(value).length === 0;
}

const isPlainObject = (value: unknown): value is StripeParams =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// CGI.escape with Stripe's bracket relaxation (Stripe::Util.url_encode)
function urlEncode(value: Scalar): string {
  const text = String(value);
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.\-~]/u.test(ch)) out += ch;
    else if (byte === 0x20) out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out.replaceAll("%5B", "[").replaceAll("%5D", "]");
}

function flatten(params: StripeParams, parentKey?: string): [string, Scalar][] {
  const result: [string, Scalar][] = [];
  for (const [key, value] of Object.entries(params)) {
    const calculated = parentKey === undefined ? key : `${parentKey}[${key}]`;
    if (Array.isArray(value)) result.push(...flattenArray(value, calculated));
    else if (isPlainObject(value)) result.push(...flatten(value, calculated));
    else result.push([calculated, value]);
  }
  return result;
}

function flattenArray(values: (Scalar | StripeParams | StripeParams[] | Scalar[])[], key: string): [string, Scalar][] {
  const result: [string, Scalar][] = [];
  values.forEach((element, index) => {
    if (Array.isArray(element)) result.push(...flattenArray(element, key));
    else if (isPlainObject(element)) result.push(...flatten(element, `${key}[${index}]`));
    else result.push([`${key}[${index}]`, element]);
  });
  return result;
}

// Stripe::Util.encode_parameters, after the client drops nil values. false, 0 and "" are kept.
export function encodeStripeParams(params: StripeParams): string {
  return flatten(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${urlEncode(key)}=${urlEncode(value)}`)
    .join("&");
}

// StripeChargeProcessor#create_payment_intent_or_charge!'s statement_description handling
export function statementDescriptorSuffix(description: string | null): string | null {
  if (description === null) return null;
  const cleaned = description
    .replaceAll(/[^A-Z0-9./\s]/giu, "")
    .trim()
    .slice(0, STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH);
  return cleaned === "" ? null : cleaned;
}

// StripeIntentChargeRouting.validate_seller_proceeds!: the first violation, as a refusal
function sellerProceedsRefusal(
  input: PaymentIntentRequestInput,
  amount: number,
  gumroadAmount: number,
): Refusal | null {
  const minimum = input.merchant.kind === "direct" ? 0 : input.merchant.kind === "destination" ? 1 : null;
  if (minimum === null) return null;
  if (amount - gumroadAmount >= minimum) return null;
  return {
    className: "ChargeProcessorCardError",
    message: SELLER_PROCEEDS_ERROR_MESSAGE,
    code: NET_NEGATIVE_SELLER_REVENUE,
  };
}

// StripeChargeProcessor#validate_upi_autopay_charge!: the first reason a stored UPI authorization cannot carry this charge.
function upiRefusal(chargeable: UpiChargeable, amount: number, currency: string, offSession: boolean): boolean {
  if (!offSession) return true;
  if (currency.toLowerCase() !== "inr") return true;
  if (!chargeable.recurringAuthorizationVerified) return true;
  if ((chargeable.recurringAuthorizationCurrency ?? "").toLowerCase() !== "inr") return true;
  const max = Math.trunc(chargeable.recurringAuthorizationMaxAmountCents ?? 0);
  if (max <= 0) return true;
  if (amount > max) return true;
  return amount > UPI_RECURRING_MAX_INR_CENTS;
}

const mandateOptionsWithoutNestedCurrency = (options: StripeParams): StripeParams => {
  const clone = structuredClone(options);
  const card = (clone.payment_method_options as StripeParams | undefined)?.card as StripeParams | undefined;
  const inner = card?.mandate_options;
  if (isPlainObject(inner) && Object.hasOwn(inner, "currency")) delete inner.currency;
  return clone;
};

export function buildPaymentIntentRequests(input: PaymentIntentRequestInput): PaymentIntentRequestResult {
  let notifications = 0;
  const refuse = (refusal: Refusal): PaymentIntentRequestResult => ({ ok: false, refusal, notifications });

  const chargeAmount = input.processorAmountCents ?? input.amountCents;
  const chargeCurrency = input.processorCurrency ?? "usd";
  const chargeGumroadAmount = input.processorGumroadAmountCents ?? input.amountForGumroadCents;
  const { chargeable } = input;
  const upi = chargeable.kind === "upi";
  const shouldSetupFutureUsage = input.setupFutureCharges && !input.offSession;

  if (chargeable.kind === "upi" && upiRefusal(chargeable, chargeAmount, chargeCurrency, input.offSession)) {
    notifications += 1;
    return refuse({
      className: "ChargeProcessorCardError",
      message: UPI_PAYMENT_METHOD_UPDATE_MESSAGE,
      code: UPI_RECURRING_AUTHORIZATION_REQUIRED,
    });
  }

  const params: StripeParams = {
    amount: chargeAmount,
    currency: chargeCurrency,
    description: input.description,
    metadata: input.metadata ?? { purchase: input.reference },
    transfer_group: input.transferGroup,
    payment_method_types: [upi ? UPI_PAYMENT_METHOD_TYPE : "card"],
    off_session: input.offSession,
    setup_future_usage: shouldSetupFutureUsage ? "off_session" : null,
  };
  if (present(input.stripeFxQuoteId)) params.fx_quote = input.stripeFxQuoteId;
  if (input.offSession) params.confirm = true;

  const requiresMandate = chargeable.kind === "payment_method" && chargeable.country === "IN";
  let mandate: string | null = null;
  if (input.offSession && requiresMandate) {
    if (present(chargeable.validatedMandateId)) mandate = chargeable.validatedMandateId;
    else mandate = input.resolvedMandateId;
  }

  if (!isBlankParams(input.mandateOptions) && !upi && !present(mandate)) {
    Object.assign(params, mandateOptionsWithoutNestedCurrency(input.mandateOptions!));
  }

  if (chargeable.kind === "upi") {
    params.customer = chargeable.customerId;
    params.payment_method = chargeable.paymentMethodId;
  } else if (input.merchant.kind === "direct") {
    params.payment_method = chargeable.paymentMethodIdOnConnectAccount;
    params.customer = chargeable.customerIdOnConnectAccount;
  } else {
    params.customer = chargeable.customerId;
    params.payment_method = chargeable.paymentMethodId;
  }

  if (input.offSession && requiresMandate) {
    if (present(mandate)) params.mandate = mandate;
    else if (input.mandateExpected) {
      notifications += 1;
      if (input.failFastWithoutMandate) {
        return refuse({
          className: "ChargeProcessorCardError",
          message: INDIA_CARD_MANDATE_MISSING_MESSAGE,
          code: INDIA_CARD_MANDATE_MISSING,
        });
      }
    }
  }

  if (shouldSetupFutureUsage && chargeable.kind === "payment_method" && chargeable.country === "IN") {
    const options = (params.payment_method_options ?? {}) as StripeParams;
    const card = (options.card ?? {}) as StripeParams;
    params.payment_method_options = { ...options, card: { ...card, request_three_d_secure: "any" } };
  }

  const suffix = statementDescriptorSuffix(input.statementDescription);
  if (suffix !== null) params.statement_descriptor_suffix = suffix;

  const headers: Record<string, string> = {};
  if (input.merchant.kind !== "platform") {
    if (!present(input.merchant.chargeProcessorMerchantId)) {
      return refuse({
        className: "RuntimeError",
        message: "Merchant account has no Charge Processor Merchant ID.",
        code: null,
      });
    }
    const proceeds = sellerProceedsRefusal(input, chargeAmount, chargeGumroadAmount);
    if (proceeds !== null) {
      notifications += 1;
      return refuse(proceeds);
    }
    if (input.merchant.kind === "direct") {
      params.application_fee_amount = chargeGumroadAmount;
      headers["Stripe-Account"] = input.merchant.chargeProcessorMerchantId;
    } else {
      params.transfer_data = {
        destination: input.merchant.chargeProcessorMerchantId,
        amount: chargeAmount - chargeGumroadAmount,
      };
    }
  }

  headers["Stripe-Version"] = present(input.stripeFxQuoteId) ? STRIPE_FX_QUOTE_API_VERSION : STRIPE_API_VERSION;
  headers["Content-Type"] = "application/x-www-form-urlencoded";

  return {
    ok: true,
    plan: {
      create: {
        method: "POST",
        path: "/v1/payment_intents",
        headers,
        body: encodeStripeParams(params),
        idempotencyKey: present(input.idempotencyKey) ? "explicit" : "generated",
      },
      confirm: {
        method: "POST",
        path: "/v1/payment_intents/pi_ID/confirm",
        headers,
        body: "",
        idempotencyKey: "generated",
      },
      notifications,
    },
  };
}
