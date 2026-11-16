// Charge::CreateService#perform for a card payment method on Gumroad's own Stripe account, USD, on-session (charge-create-service.rb):
// find the order's charge for the seller, stamp it and the purchases with the card, create and confirm the PaymentIntent, and store
// the intent on the charge. What happens to a purchase on each outcome is Ruby's: a decline or a Stripe error is written onto the
// purchases' errors, `error_code` and `stripe_error_code`, and never thrown.
// Golden: __fixtures__/purchase-paid-order.golden.json, the span between its `Charge::CreateService` markers.
//
// Nothing writes or calls Stripe before assertChargeCreateServable has passed: it refuses, reading only, what the golden does not
// cover (a buyer-currency presentment, a resumed setup, a card on file, a seller's own Stripe account, ...).
// Refused after the first Stripe call, which is the one place this port still throws after an external call: a failed card that
// left presentment rows behind, which `clear_buyer_currency_presentments` would destroy and no recording covers.
import { Prisma, type Charge } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";
import {
  ChargeProcessorCardError,
  ChargeProcessorErrorGeneric,
  ChargeProcessorErrorRateLimit,
  ChargeProcessorFxQuoteInvalidError,
  ChargeProcessorInvalidRequestError,
  ChargeProcessorUnavailableError,
} from "../stripe/charge-processor-errors.ts";
import type { RequestOptions } from "../stripe/client.ts";

import { ChargeFlags, Charges } from "./charge-record.ts";
import { type CheckoutEffects, defaultCheckoutEffects } from "./checkout-effects.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { Purchases, type PurchaseRecord } from "./purchase-create.ts";
import { externalId } from "./refund.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { selectRows, castRow, column, table } from "./sql.ts";
import type { StripeChargeablePaymentMethod } from "./stripe-chargeable-payment-method.ts";
import {
  createPaymentIntentOrCharge,
  assertPaymentIntentServable,
  type ChargeIntent,
} from "./stripe-payment-intent-create.ts";
import type { PaymentIntentRequestInput } from "./stripe-payment-intent-request.ts";
import { NotPortedError } from "./user.ts";

export type ChargeRecord = ModelRecord<Charge>;

export const COMBINED_CHARGE_PREFIX = "CH-";
export const BUYER_CURRENCY_CHARGING_FEATURE = "buyer_currency_charging";
export const GENERIC_PROCESSOR_FAILURE_MESSAGE =
  "There is a temporary problem, please try again (your card was not charged).";
export const BUYER_CURRENCY_QUOTE_INVALID_MESSAGE =
  "The local-currency price changed or expired. Please review the updated total and try again.";
const STRIPE_PROCESSOR_ID = "stripe";
const STRIPE_UNAVAILABLE = "stripe_unavailable";
const PROCESSOR_INVALID_REQUEST = "processor_invalid_request";
const BUYER_CURRENCY_QUOTE_INVALID = "buyer_currency_quote_invalid";
const DEFAULT_CARD_DECLINED_MESSAGE = "Your card was declined. Please try a different card or contact your bank.";
// StripeMetadata.build_metadata_large_list
const METADATA_VALUE_MAX_LENGTH = 500;
const METADATA_MAX_KEYS = 50;
// PurchaseErrorCode::PROCESSOR_ERROR_CODE_MAP
const NAMED_PROCESSOR_ERROR_CODES: Record<string, string> = {
  insufficient_capabilities_for_transfer: "processor_merchant_cannot_receive_transfers",
  COMPLIANCE_VIOLATION: "paypal_payee_compliance_violation",
};
const NAMED_BUYER_MESSAGES: Record<string, string> = {
  processor_merchant_cannot_receive_transfers:
    "This creator isn't able to accept payments right now. Your card was not charged — please try again later.",
  paypal_payee_compliance_violation:
    "This creator can't accept this PayPal payment. Your PayPal account was not charged.",
};

export type ChargeCreateInput = {
  order: { id: bigint };
  seller: { id: bigint };
  // `merchant_account`: the shared Gumroad Stripe account, the only one recorded
  merchantAccount: { id: bigint; charge_processor_id: string; user_id: bigint | null };
  chargeable: StripeChargeablePaymentMethod;
  // Already linked to the order's charge by Order::ChargeService, carrying the card details it set
  purchases: PurchaseRecord[];
  amountCents: number;
  gumroadAmountCents: number;
  setupFutureCharges: boolean;
  offSession: boolean;
  statementDescription: string | null;
  mandateOptions: PaymentIntentRequestInput["mandateOptions"];
  params: { buyer_currency_quote?: string | null; setup_confirmed_resume?: unknown };
};

export type ChargeCreateOptions = {
  now: () => Date;
  client?: RequestOptions["client"];
  effects?: CheckoutEffects;
};

export type ChargeCreateResult = {
  charge: ChargeRecord;
  chargeIntent: ChargeIntent | null;
  // `processor_outcome_unknown`: the connection to Stripe failed, so the intent may have been created, even confirmed
  processorOutcomeUnknown: boolean;
  // Not in Ruby: the id of the intent created before a lost confirm, which Rails never stores
  lostIntentId: string | null;
};

const notPorted = (what: string) =>
  new NotPortedError(`Charge::CreateService with ${what}`, "app/services/charge/create_service.rb");
const present = (value: unknown) => typeof value === "string" && value.trim() !== "";

// Reads only. `buyer_currency_charging` is Flipper-read for the seller exactly as Checkout::BuyerCurrencyEligibility#decision does;
// every other presentment path needs a quote token, an off-session charge or a resumed setup, which are refused by their inputs.
export async function assertChargeCreateServable(
  input: ChargeCreateInput,
  options: ChargeCreateOptions,
): Promise<void> {
  const refuse = (condition: boolean, what: string) => {
    if (condition) throw notPorted(what);
  };
  refuse(input.merchantAccount.charge_processor_id !== STRIPE_PROCESSOR_ID, "a processor other than Stripe");
  refuse(input.merchantAccount.user_id !== null, "a seller's own merchant account");
  refuse(present(input.params.buyer_currency_quote), "a buyer-currency quote token");
  refuse(Boolean(input.params.setup_confirmed_resume), "a resumed setup");
  refuse(input.purchases.length === 0, "no purchases");
  refuse(
    input.purchases.some((purchase) => purchase.get("credit_card_id") != null),
    "a purchase with a stored card",
  );
  const effects = options.effects ?? defaultCheckoutEffects;
  refuse(
    await effects.featureActive(BUYER_CURRENCY_CHARGING_FEATURE, `User;${String(input.seller.id)}`),
    "a seller on buyer-currency charging",
  );
  assertPaymentIntentServable(intentInput(input, { reference: "", metadata: {}, description: "", transferGroup: "" }));
}

// StripeMetadata.build_metadata_large_list(items, key: :purchases, separator: ",")
export function purchasesMetadata(items: string[]): Record<string, string> {
  const slices: string[] = [];
  for (const item of items) {
    const last = slices.at(-1);
    if (last === undefined || last.length + 1 + item.length > METADATA_VALUE_MAX_LENGTH) slices.push(item);
    else slices[slices.length - 1] = `${last},${item}`;
  }
  return Object.fromEntries(
    slices.slice(0, METADATA_MAX_KEYS + 1).map((slice, index) => [`purchases{${index}}`, slice]),
  );
}

function intentInput(
  input: ChargeCreateInput,
  names: { reference: string; description: string; metadata: Record<string, string>; transferGroup: string },
): PaymentIntentRequestInput {
  return {
    merchant: { kind: "platform" },
    chargeable: input.chargeable.toIntentChargeable(),
    amountCents: input.amountCents,
    amountForGumroadCents: input.gumroadAmountCents,
    reference: names.reference,
    description: names.description,
    metadata: names.metadata,
    statementDescription: input.statementDescription,
    transferGroup: names.transferGroup,
    offSession: input.offSession,
    setupFutureCharges: input.setupFutureCharges,
    mandateOptions: input.mandateOptions,
    mandateExpected: false,
    resolvedMandateId: null,
    failFastWithoutMandate: false,
    processorAmountCents: null,
    processorCurrency: null,
    processorGumroadAmountCents: null,
    stripeFxQuoteId: null,
    idempotencyKey: null,
  };
}

// `order.charges.find_or_create_by!(seller:)`: the charge Order::ChargeService created. A missing one means a caller this port
// does not serve, found out by the read alone.
async function findCharge(input: ChargeCreateInput): Promise<ChargeRecord> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`charges`.*")} FROM ${table("charges")} WHERE ${column("charges", "order_id")} = ${input.order.id} AND ${column("charges", "seller_id")} = ${input.seller.id} LIMIT 1`,
  );
  if (!row) throw notPorted("an order without a charge for the seller");
  // The association was built from the order and the seller, so the two required belongs_to validations send no query.
  const charge = Charges.load(castRow<Charge>("Charge", row));
  setAssociation(charge, "order", input.order.id, input.order);
  setAssociation(charge, "seller", input.seller.id, input.seller);
  return charge;
}

type Failure = {
  message: string;
  errorCode?: string;
  stripeErrorCode?: string | null;
  stripeTransactionId?: string | null;
  zipcodeCheckPerformed?: boolean;
};

function applyFailure(purchases: PurchaseRecord[], failure: Failure): void {
  for (const purchase of purchases) {
    purchase.errors.add("base", failure.message);
    if (failure.errorCode !== undefined) purchase.set("error_code", failure.errorCode);
    if (failure.stripeErrorCode !== undefined) purchase.set("stripe_error_code", failure.stripeErrorCode);
    if (failure.stripeTransactionId !== undefined) purchase.set("stripe_transaction_id", failure.stripeTransactionId);
    if (failure.zipcodeCheckPerformed)
      purchase.set("flags", PurchaseFlags.set(purchase.get("flags"), "was_zipcode_check_performed", true) as never);
  }
}

// with_charge_processor_error_handler, for the errors a card payment method on the platform account can raise. `null` is Ruby's
// `nil` (no intent); the rate limit is marked on the purchases and then re-raised.
function handleProcessorError(error: unknown, purchases: PurchaseRecord[]): { unknownOutcome: boolean } {
  if (error instanceof ChargeProcessorFxQuoteInvalidError) {
    applyFailure(purchases, { message: BUYER_CURRENCY_QUOTE_INVALID_MESSAGE, errorCode: BUYER_CURRENCY_QUOTE_INVALID });
    return { unknownOutcome: false };
  }
  if (error instanceof ChargeProcessorInvalidRequestError) {
    if (/must match the payment intent's settlement currency/iu.test(error.message)) {
      // Ruby also records the learned marker on the merchant account; the recordings never reach it, so it is not written here.
      applyFailure(purchases, {
        message: BUYER_CURRENCY_QUOTE_INVALID_MESSAGE,
        errorCode: BUYER_CURRENCY_QUOTE_INVALID,
      });
      return { unknownOutcome: false };
    }
    const code = NAMED_PROCESSOR_ERROR_CODES[error.processorErrorCode ?? ""] ?? PROCESSOR_INVALID_REQUEST;
    for (const purchase of purchases) {
      purchase.set("error_code", code);
      purchase.errors.add("base", NAMED_BUYER_MESSAGES[code] ?? GENERIC_PROCESSOR_FAILURE_MESSAGE);
      if (!present(purchase.get("stripe_error_code"))) purchase.set("stripe_error_code", error.processorErrorCode);
    }
    return { unknownOutcome: false };
  }
  if (error instanceof ChargeProcessorUnavailableError) {
    applyFailure(purchases, { message: GENERIC_PROCESSOR_FAILURE_MESSAGE, errorCode: STRIPE_UNAVAILABLE });
    return { unknownOutcome: true };
  }
  if (error instanceof ChargeProcessorCardError) {
    applyFailure(purchases, {
      message: error.message === "" ? DEFAULT_CARD_DECLINED_MESSAGE : error.message,
      stripeErrorCode: error.errorCode,
      stripeTransactionId: error.chargeId,
      zipcodeCheckPerformed: error.errorCode === "incorrect_zip",
    });
    return { unknownOutcome: false };
  }
  if (error instanceof ChargeProcessorErrorRateLimit) {
    applyFailure(purchases, { message: GENERIC_PROCESSOR_FAILURE_MESSAGE, errorCode: STRIPE_UNAVAILABLE });
    throw error;
  }
  if (error instanceof ChargeProcessorErrorGeneric) {
    applyFailure(purchases, { message: GENERIC_PROCESSOR_FAILURE_MESSAGE, stripeErrorCode: error.errorCode });
    return { unknownOutcome: false };
  }
  throw error;
}

// clear_buyer_currency_presentments: only the lookups, in one transaction. A row found would be destroyed by Ruby.
async function clearBuyerCurrencyPresentments(purchases: PurchaseRecord[], charge: ChargeRecord): Promise<void> {
  await transaction(async () => {
    for (const purchase of purchases) {
      const rows = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`purchase_presentments`.*")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
      );
      if (rows.length > 0) throw notPorted("a purchase presentment left behind by a failed card");
    }
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`charge_presentments`.*")} FROM ${table("charge_presentments")} WHERE ${column("charge_presentments", "charge_id")} = ${charge.get("id")} LIMIT 1`,
    );
    if (rows.length > 0) throw notPorted("a charge presentment left behind by a failed card");
  });
}

export async function performChargeCreate(
  input: ChargeCreateInput,
  options: ChargeCreateOptions,
): Promise<ChargeCreateResult> {
  await assertChargeCreateServable(input, options);

  const charge = await findCharge(input);
  const saveOptions = { now: options.now };
  await Charges.updateBang(
    charge,
    {
      merchant_account_id: input.merchantAccount.id,
      processor: input.merchantAccount.charge_processor_id,
      amount_cents: BigInt(input.amountCents),
      gumroad_amount_cents: BigInt(input.gumroadAmountCents),
      payment_method_fingerprint: input.chargeable.fingerprint,
    },
    saveOptions,
  );
  for (const purchase of input.purchases) await Purchases.saveBang(purchase, saveOptions);

  const chargeExternalId = externalId(charge.get("id"));
  const request = intentInput(input, {
    reference: `${COMBINED_CHARGE_PREFIX}${chargeExternalId}`,
    description: `Gumroad Charge ${chargeExternalId}`,
    metadata: purchasesMetadata(input.purchases.map((purchase) => externalId(purchase.get("id")))),
    transferGroup: `${COMBINED_CHARGE_PREFIX}${String(charge.get("id"))}`,
  });

  let chargeIntent: ChargeIntent | null = null;
  let unknownOutcome = false;
  let lostIntentId: string | null = null;
  try {
    chargeIntent = await createPaymentIntentOrCharge(request, { client: options.client, now: options.now() });
  } catch (error) {
    if (error instanceof ChargeProcessorUnavailableError) lostIntentId = error.lostIntentId;
    unknownOutcome = handleProcessorError(error, input.purchases).unknownOutcome;
  }

  if (chargeIntent === null && !unknownOutcome && !ChargeFlags.isSet(charge.get("flags"), "client_confirmed"))
    await clearBuyerCurrencyPresentments(input.purchases, charge);

  if (chargeIntent !== null) {
    charge.set("payment_method_fingerprint", input.chargeable.fingerprint);
    charge.set("stripe_payment_intent_id", chargeIntent.id);
    if (chargeIntent.outcome === "succeeded" && chargeIntent.charge !== null) {
      charge.set("processor_transaction_id", chargeIntent.charge.id);
      charge.set("processor_fee_cents", chargeIntent.charge.fee === null ? null : BigInt(chargeIntent.charge.fee));
      charge.set("processor_fee_currency", chargeIntent.charge.feeCurrency);
    }
    await Charges.saveBang(charge, saveOptions);
  }
  return { charge, chargeIntent, processorOutcomeUnknown: unknownOutcome, lostIntentId };
}
