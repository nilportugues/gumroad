// Create side of app/models/purchase.rb for a free ($0, one-time, USD) checkout: the validations, the before_create guards,
// has_paper_trail, the refund policy snapshot, the inventory counter callbacks and the commit hooks of a Purchase saved in
// the `in_progress` state (golden: __fixtures__/purchase-create.golden.json, scripts/golden/purchase-create.rb).
//
// Every other purchase is refused with NotPortedError before the first write, so the caller can hand the request back
// to Rails: a variant, an offer code, a gift, a subscription or installment plan, a preorder, a physical or licensed
// product, a call, a rental, a quantity limit, a tip or a priced purchase. The guards read what the caller loaded
// (`PurchaseContext`) the way Ruby reads the `link` and `seller` associations, and send the statements Ruby sends.
import { Prisma, type Link, type Purchase, type PurchaseRefundPolicy, type User } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { defaultCheckoutEffects, type CheckoutEffects } from "./checkout-effects.ts";
import { alpha2ByName } from "./compliance-countries.ts";
import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { ago } from "./concerns/ruby-time.ts";
import { LinkFlags } from "./link.ts";
import { PurchaseRefundPolicies } from "./purchase-refund-policy.ts";
import { PurchaseUrlParameters } from "./purchase-url-parameter.ts";
import { heldGiftGiven, heldSubscription } from "./refund-held-associations.ts";
import { defineModel, type Callback, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";
import { subscriptionView } from "./subscription-writes.ts";
import {
  isValidEmailFormat,
  mailAddressDomain,
  MAX_PRICE_USD_CENTS_UNLESS_VERIFIED,
  jsonDataForAttr as userJsonDataForAttr,
  NotPortedError,
  strippedFieldWith,
  Users,
} from "./user.ts";

export type PurchaseRecord = ModelRecord<Purchase>;

export const PURCHASES = "purchases";
// Purchase::UNFINISHED_PURCHASE_RETRY_BLOCK
const UNFINISHED_PURCHASE_RETRY_BLOCK = { minutes: 15 };
// not_double_charged: 3.minutes.ago, the confirmation window of a plain product
const DOUBLE_CHARGE_WINDOW = { minutes: 3 };
// cancel_parallel_charge_intents
const PARALLEL_CHARGE_INTENT_WINDOW = { hours: 1 };
// Purchase::Reviews, Purchase::AudienceMember and ElasticsearchModelAsyncCallbacks delays
const ELASTICSEARCH_INDEX_DELAY_SECONDS = 2;
// Purchase::Risk::CHECK_FOR_FRAUD_TIMEOUT_SECONDS is not modelled: no guard here waits on anything but MySQL.

// PurchaseErrorCode
export const PurchaseErrorCode = {
  PRICE_TOO_HIGH: "price_too_high",
  BLOCKED_BROWSER_GUID: "blocked_browser_guid",
  BLOCKED_EMAIL_DOMAIN: "blocked_email_domain",
  BUYER_CHARGED_BACK: "buyer_has_charged_back",
  PRICE_CENTS_TOO_LOW: "price_cents_too_low",
  CONTRIBUTION_TOO_LOW: "contribution_too_low",
  PERCEIVED_PRICE_CENTS_NOT_MATCHING: "perceived_price_cents_not_matching",
  INVALID_QUANTITY: "invalid_quantity",
  NOT_FOR_SALE: "not_for_sale",
  TEMPORARILY_BLOCKED_PRODUCT: "product_temporarily_blocked",
  BLOCKED_SANCTIONED_LOCATION: "compliance_blocked_location",
  DUPLICATE_PURCHASE_CONFIRMATION_REQUIRED: "duplicate_purchase_confirmation_required",
} as const;

export const BLOCKED_IDENTIFIER_ERROR =
  "Your card was not charged. This payment could not be completed — please contact support@gumroad.com for help.";

// Compliance::Countries::BLOCKED_COUNTRY_CODES and BLOCKED_SUBDIVISION_CODES
const BLOCKED_COUNTRY_CODES: readonly string[] = ["CU", "IR", "KP"];
const BLOCKED_SUBDIVISION_CODES: Record<string, readonly string[]> = {
  UA: ["43", "40", "14", "09"],
  RU: ["CR", "SEV"],
};

export function isBlockedLocation(alpha2: string | null | undefined, subdivision: string | null | undefined): boolean {
  if (!alpha2) return false;
  if (BLOCKED_COUNTRY_CODES.includes(alpha2)) return true;
  if (!subdivision) return false;
  const country = alpha2.toUpperCase();
  const codes = BLOCKED_SUBDIVISION_CODES[country];
  return codes?.includes(subdivision.toUpperCase().replace(new RegExp(`^${country}-`, "u"), "")) ?? false;
}

// What the caller loaded for the purchase: Ruby's `purchase.link`, `purchase.seller` and `purchase.purchaser`, the
// GeoIp lookup of the buyer's address (`geo_info`), and the refund policy snapshot `Purchase::CreateService` builds.
export type PurchaseContext = {
  link: Link;
  seller: User;
  purchaserEmail?: string | null;
  // `User.find_by(email: params[:email])`, which the service ran when it picked the purchaser, with the email it ran it for.
  // The email is stripped and downcased when the purchase validates, so the fraud check asks again unless it came out the same
  // (the query cache answers it then).
  buyerByEmail: User | null;
  buyerLookupEmail?: string | null;
  geoInfo?: { countryCode: string | null; regionName: string | null; postalCode?: string | null } | null;
  refundPolicy?: Pick<PurchaseRefundPolicy, "max_refund_period_in_days" | "title" | "fine_print"> | null;
  // `purchase.order_purchase&.order_id`, which `order.purchases << purchase` leaves loaded
  orderId?: bigint | null;
  // `uses_charge_receipt?`: the purchase belongs to a charge that belongs to an order (one SendChargeReceiptJob, no purchase receipt)
  chargeReceipt?: boolean;
  // `purchase.url_parameters`, the parsed PurchaseUrlParameter row the sale ping carries
  urlParameters?: Record<string, unknown> | null;
  // The parameters the purchase saves into its PurchaseUrlParameter row
  urlParametersToSave?: Record<string, unknown> | null;
  // The Redis, Flipper and random reads of the success transition and of the commit hooks
  effects?: CheckoutEffects;
};

const effectsOf = (record: PurchaseRecord): CheckoutEffects => contextOf(record).effects ?? defaultCheckoutEffects;

const contextOf = (record: PurchaseRecord): PurchaseContext => {
  const context = record.ivars.context as PurchaseContext | undefined;
  if (!context) throw new Error("A Purchase is saved with its PurchaseContext (record.ivars.context)");
  return context;
};

export const withContext = (record: PurchaseRecord, context: PurchaseContext): PurchaseRecord => {
  record.ivars.context = context;
  setAssociation(record, "link", record.get("link_id"), context.link as never);
  setAssociation(record, "seller", record.get("seller_id"), context.seller as never);
  return record;
};

const flag = (record: PurchaseRecord, name: (typeof PurchaseFlags.names)[number]) =>
  PurchaseFlags.isSet(record.get("flags"), name);
const linkFlag = (link: Link, name: (typeof LinkFlags.names)[number]) => LinkFlags.isSet(link.flags, name);

const notPorted = (what: string) => new NotPortedError(`Purchase create with ${what}`, "app/models/purchase.rb");

// Whether the purchase is one the free path covers; everything else hands back before the first statement.
export function assertFreeCheckoutPurchase(record: PurchaseRecord, context: PurchaseContext): void {
  const { link } = context;
  const refuse = (condition: boolean, what: string) => {
    if (condition) throw notPorted(what);
  };
  refuse(record.get("price_cents") !== 0 || (record.get("shipping_cents") ?? 0) !== 0, "a priced purchase");
  refuse(record.get("subscription_id") != null, "a subscription");
  refuse(record.get("offer_code_id") != null, "an offer code");
  refuse(
    record.get("purchaser_id") != null && context.purchaserEmail === undefined,
    "a purchaser whose email is not loaded",
  );
  for (const name of [
    "is_gift_sender_purchase",
    "is_gift_receiver_purchase",
    "is_preorder_authorization",
    "is_rental",
    "is_installment_payment",
    "is_free_trial_purchase",
    "is_bundle_product_purchase",
    "is_upgrade_purchase",
    "is_additional_contribution",
    "is_commission_completion_purchase",
    "is_commission_deposit_purchase",
    "is_purchasing_power_parity_discounted",
    "is_original_subscription_purchase",
  ] as const)
    refuse(flag(record, name), name);
  for (const name of [
    "is_recurring_billing",
    "is_physical",
    "is_licensed",
    "is_in_preorder_state",
    "is_tiered_membership",
    "is_bundle",
    "quantity_enabled",
    "skus_enabled",
    "free_trial_enabled",
    "waitlist_enabled",
    "block_access_after_membership_cancellation",
  ] as const)
    refuse(linkFlag(link, name), `a product with ${name}`);
  refuse(link.native_type !== "digital", `a ${link.native_type} product`);
  refuse(Boolean(link.require_shipping), "a product that requires shipping");
  refuse(link.max_purchase_count != null, "a product with a purchase limit");
  refuse((link.price_cents ?? 0) !== 0 || (link.price_currency_type ?? "usd") !== "usd", "a priced or non-USD product");
  refuse(record.get("quantity") !== 1, "a quantity other than one");
  refuse(record.get("recommender_model_name" as never) != null, "a recommender model");
}

// ---- PlatformBlock reads ------------------------------------------------------------------------------------------

const BLOCKS = "platform_blocks";
const activeBlocks = (now: Date) =>
  Prisma.sql`${column(BLOCKS, "blocked_at")} IS NOT NULL AND (expires_at IS NULL OR expires_at > ${now})`;

// PlatformBlock.<type>.active.find_by(object_value:)
async function activeBlockExists(now: Date, objectValue: string, objectType?: string): Promise<boolean> {
  const rows = await selectRows(
    objectType
      ? Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(BLOCKS)} WHERE ${column(BLOCKS, "object_type")} = ${objectType} AND ${activeBlocks(now)} AND ${column(BLOCKS, "object_value")} = ${objectValue} LIMIT 1`
      : Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(BLOCKS)} WHERE ${activeBlocks(now)} AND ${column(BLOCKS, "object_value")} = ${objectValue} LIMIT 1`,
  );
  return rows.length > 0;
}

// AttributeBlockable#blocked_by_<attribute>? for an email domain: `PlatformBlock.active.where(...).first`
async function emailDomainBlocked(now: Date, domain: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(BLOCKS)} WHERE ${activeBlocks(now)} AND ${column(BLOCKS, "object_value")} = ${domain} AND ${column(BLOCKS, "object_type")} = ${"email_domain"} ORDER BY ${column(BLOCKS, "id")} ASC LIMIT 1`,
  );
  return rows.length > 0;
}

const nowOf = (ctx: CallbackContext) => (ctx.now ?? (() => new Date()))();

// ---- Validations ------------------------------------------------------------------------------------------------

// `where.not_is_gift_sender_purchase` (flag_shih_tzu bit_operator): the SQL ActiveRecord renders for it
const notGiftSender = Prisma.sql`((${column(PURCHASES, "flags")} & 64 = 0))`;

const star = Prisma.raw("`purchases`.*");

// stripped_fields :email, remove_duplicate_spaces: false, nilify_blanks: false, transform: downcase,
//   if: -> { email.present? && email_changed? }
const strippedEmail: Callback<Purchase> = {
  name: "stripped_fields :email",
  if: (record) => record.get("email") != null && record.get("email")!.trim() !== "" && record.attributeChanged("email"),
  run(record) {
    record.set(
      "email",
      strippedFieldWith(record.get("email"), {
        removeDuplicateSpaces: false,
        nilifyBlanks: false,
        transform: (value) => value.toLowerCase(),
      }) as never,
    );
  },
};

const mustHaveValidEmail: Callback<Purchase> = {
  name: "must_have_valid_email",
  run(record) {
    // `return if email && !email_changed?`: a new record's email is always changed
    if (!isValidEmailFormat(record.get("email"))) record.errors.add("base", "valid email required");
  },
};

// `validates :purchaser, presence: true, if: -> { is_gift_receiver_purchase && gift&.is_recipient_hidden? }`: `gift` is `gift_received`,
// loaded once per record
const giftRecipientHiddenNeedsPurchaser: Callback<Purchase> = {
  name: "purchaser presence for a hidden gift recipient",
  async run(record) {
    if (!flag(record, "is_gift_receiver_purchase")) return;
    const memo = record.ivars as { giftReceived?: { flags: unknown } | null };
    if (memo.giftReceived === undefined) {
      const [gift] = await selectRows<{ flags: unknown }>(
        Prisma.sql`SELECT ${Prisma.raw("`gifts`.*")} FROM ${table("gifts")} WHERE ${column("gifts", "giftee_purchase_id")} = ${record.get("id")} LIMIT 1`,
      );
      memo.giftReceived = gift ?? null;
    }
    // is_recipient_hidden is bit 1 of gifts.flags
    if (memo.giftReceived !== null && (BigInt(memo.giftReceived.flags as bigint | number) & 1n) !== 0n)
      throw notPorted("a gift whose recipient is hidden");
  },
};

const notDoubleCharged: Callback<Purchase> = {
  name: "not_double_charged",
  on: "create",
  async run(record, ctx) {
    const { link } = contextOf(record);
    if (flag(record, "is_bundle_product_purchase") || flag(record, "is_gift_receiver_purchase")) return;
    if (linkFlag(link, "allow_double_charges")) return;
    const now = nowOf(ctx);
    const email = record.get("email");
    const guid = record.get("browser_guid");

    // cancel_parallel_charge_intents: a prior in-progress attempt with a payment intent would be cancelled at Stripe
    const parallel = await selectRows(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "browser_guid")} ${guid === null ? Prisma.raw("IS NULL") : Prisma.sql`= ${guid}`} AND ${column(PURCHASES, "link_id")} = ${link.id} AND ${column(PURCHASES, "purchase_state")} = ${"in_progress"} AND ${column(PURCHASES, "processor_payment_intent_id")} IS NOT NULL AND (created_at > ${ago(PARALLEL_CHARGE_INTENT_WINDOW, now)})`,
    );
    if (parallel.length > 0) throw notPorted("an earlier attempt that holds a payment intent");

    const lastAllowedPurchaseAt = ago(DOUBLE_CHARGE_WINDOW, now);
    const retryBlock = ago(UNFINISHED_PURCHASE_RETRY_BLOCK, now);
    const lastAllowedInProgressAt = lastAllowedPurchaseAt < retryBlock ? lastAllowedPurchaseAt : retryBlock;
    const states = ["successful", "in_progress"];
    const already = await selectRows<Purchase>(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "email")} = ${email} AND ${column(PURCHASES, "ip_address")} = ${record.get("ip_address")} AND ${column(PURCHASES, "link_id")} = ${link.id} AND ${column(PURCHASES, "purchase_state")} IN (${Prisma.join(states, ", ")}) AND (purchases.created_at > ${lastAllowedInProgressAt}) AND ${notGiftSender}`,
    );
    const alreadyGifted = await selectRows<Purchase>(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} INNER JOIN ${table("gifts")} ON ${column("gifts", "gifter_purchase_id")} = ${column(PURCHASES, "id")} WHERE ${column("gifts", "giftee_email")} = ${email} AND ${column(PURCHASES, "link_id")} = ${link.id} AND ${column(PURCHASES, "purchase_state")} IN (${Prisma.join(states, ", ")}) AND (purchases.created_at > ${lastAllowedInProgressAt})`,
    );

    // `already.reject(&outside_window)`: a finished purchase older than the window does not count
    const blocking = [...already, ...alreadyGifted].filter(
      (purchase) => purchase.purchase_state === "in_progress" || purchase.created_at! > lastAllowedPurchaseAt,
    );
    if (blocking.some((purchase) => purchase.purchase_state === "in_progress" && purchase.processor_payment_intent_id))
      throw notPorted("an earlier attempt whose payment intent must be rechecked");
    if (blocking.some((purchase) => purchase.purchase_state === "successful")) {
      record.set("error_code", PurchaseErrorCode.DUPLICATE_PURCHASE_CONFIRMATION_REQUIRED);
      record.errors.add(
        "base",
        "You have already paid for this product. It has been emailed to you. Do you want to buy it again?",
      );
    } else if (blocking.length > 0) {
      record.errors.add(
        "base",
        "You have already attempted to purchase this product. We will email you shortly if the purchase is successful.",
      );
    }
    if (!record.errors.isEmpty()) return;

    // not_double_charged_while_payment_settling
    const settling = await selectRows(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "purchase_state")} = ${"in_progress"} AND ${column(PURCHASES, "stripe_status")} IS NOT NULL AND ${column(PURCHASES, "email")} = ${email} AND ${column(PURCHASES, "link_id")} = ${link.id} AND ${notGiftSender}`,
    );
    const settlingGifts = await selectRows(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} INNER JOIN ${table("gifts")} ON ${column("gifts", "gifter_purchase_id")} = ${column(PURCHASES, "id")} WHERE ${column(PURCHASES, "purchase_state")} = ${"in_progress"} AND ${column(PURCHASES, "stripe_status")} IS NOT NULL AND ${column("gifts", "giftee_email")} = ${email} AND ${column(PURCHASES, "link_id")} = ${link.id}`,
    );
    if (settling.length + settlingGifts.length > 0) throw notPorted("an earlier payment that is still settling");
  },
};

const sellerIsLinkUser: Callback<Purchase> = {
  name: "seller_is_link_user",
  run(record) {
    const { link, seller } = contextOf(record);
    if (seller.id !== link.user_id) record.errors.add("base", "link does not belong to user");
  },
};

const presence = (
  attributes: ("seller_id" | "price_cents" | "total_transaction_cents" | "fee_cents")[],
): Callback<Purchase> => ({
  name: `validates ${attributes.join(", ")}, presence: true`,
  run(record) {
    for (const attribute of attributes)
      if (record.get(attribute) == null) record.errors.add(attribute === "seller_id" ? "seller" : attribute, "blank");
  },
});

// validates :custom_fee_per_thousand, allow_nil: true, numericality: { only_integer: true, >= 0, <= 1000 }
const CUSTOM_FEE_PER_THOUSAND_MAX = 1000;
const customFeePerThousand: Callback<Purchase> = {
  name: "validates custom_fee_per_thousand, numericality",
  run(record) {
    const value = jsonDataOf(record).custom_fee_per_thousand;
    if (value == null) return;
    const attribute = "custom_fee_per_thousand";
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^[+-]?\d+(\.\d+)?$/u.test(value.trim())
          ? Number(value)
          : NaN;
    if (Number.isNaN(number)) return record.errors.add(attribute, "not_a_number");
    if (!Number.isInteger(number)) return record.errors.add(attribute, "not_an_integer");
    if (number < 0) return record.errors.add(attribute, "greater_than_or_equal_to", { count: 0 });
    if (number > CUSTOM_FEE_PER_THOUSAND_MAX)
      record.errors.add(attribute, "less_than_or_equal_to", { count: CUSTOM_FEE_PER_THOUSAND_MAX });
  },
};

// state :successful { validate { financial_transaction_validation } }: a free purchase carries no processor trace
const financialTransactionValidation: Callback<Purchase> = {
  name: "financial_transaction_validation",
  if: (record) => record.get("purchase_state") === "successful",
  run(record) {
    const price = record.get("price_cents");
    // A charged purchase: the processor's trace, with `merchant_account` already assigned to the instance that was charged
    // (a nonzero id here stands for `merchant_account.present?`, which would be the one SELECT of a purchase loaded by `find`).
    if (
      price !== null &&
      price > 0 &&
      record.get("stripe_transaction_id") &&
      record.get("merchant_account_id") != null &&
      (record.get("stripe_fingerprint") || record.get("paypal_order_id") != null) &&
      record.get("charge_processor_id")
    )
      return;
    if (
      (price === 0 || price === null) &&
      !record.get("stripe_transaction_id") &&
      !record.get("stripe_fingerprint") &&
      record.get("charge_processor_id") == null &&
      record.get("merchant_account_id") == null
    )
      return;
    record.errors.add("base", "We couldn't charge your card. Try again or use a different card.");
  },
};

// ---- before_create guards ----------------------------------------------------------------------------------------

const addError = (record: PurchaseRecord, code: string, message: string) => {
  record.set("error_code", code);
  record.errors.add("base", message);
};

const productIsSellable: Callback<Purchase> = {
  name: "product_is_sellable",
  run(record) {
    const { link, seller } = contextOf(record);
    // User#suspended?: admin-suspended or suspended-for-fraud/-tos
    const suspended = ["suspended_for_fraud", "suspended_for_tos_violation"].includes(seller.user_risk_state ?? "");
    const alive = link.purchase_disabled_at === null && link.banned_at === null && link.deleted_at === null;
    if (suspended || !alive)
      addError(record, PurchaseErrorCode.NOT_FOR_SALE, "This product is not currently for sale.");
  },
};

const freeProductIpAddressIsNotBlocked: Callback<Purchase> = {
  name: "free_product_ip_address_is_not_blocked",
  async run(record, ctx) {
    const { link } = contextOf(record);
    const ip = record.get("ip_address");
    if (record.get("link_id") == null || !ip) return;
    const purchaserId = record.get("purchaser_id");
    if (purchaserId != null && purchaserId === link.user_id) return;
    if (!(await activeBlockExists(nowOf(ctx), `${String(record.get("link_id"))}:${ip}`, "product_ip_address"))) return;
    addError(record, PurchaseErrorCode.TEMPORARILY_BLOCKED_PRODUCT, "The transaction could not complete.");
  },
};

// `link.variant_categories_alive`: `.empty?` asks EXISTS, a later read loads the rows, and `.count` counts them.
const variantCategories = (record: PurchaseRecord) => {
  const cache = record.ivars as { variantCategories?: Promise<unknown[]> };
  const link = contextOf(record).link;
  return (cache.variantCategories ??= selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${link.id} AND ${column("variant_categories", "deleted_at")} IS NULL`,
  ));
};

const variantsAvailable: Callback<Purchase> = {
  name: "variants_available",
  async run(record) {
    // closed_new_variants and new_variants are empty without variant_attributes
    const { link } = contextOf(record);
    const rows = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${link.id} AND ${column("variant_categories", "deleted_at")} IS NULL LIMIT 1`,
    );
    if (rows.length > 0) throw notPorted("a product with variants");
  },
};

const variantsSatisfied: Callback<Purchase> = {
  name: "variants_satisfied",
  async run(record) {
    const { link } = contextOf(record);
    // (link.variant_categories_alive.map(&:id) & variant_attributes.map(&:variant_category_id)).count == link.variant_categories_alive.count
    const categories = await variantCategories(record);
    const counted = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT COUNT(*) FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${link.id} AND ${column("variant_categories", "deleted_at")} IS NULL`,
    );
    if (categories.length !== Number(counted[0]!["COUNT(*)"]))
      throw new Error("variant categories changed while the purchase was checked");
    if (categories.length > 0) throw notPorted("a product with variants");
  },
};

// price_not_too_low and perceived_price_cents_matches_price_cents read `minimum_paid_price_cents`, which for a free
// one-time product with no variant or offer code is the product's price in its currency.
async function minimumPaidPriceCents(record: PurchaseRecord): Promise<number> {
  const memo = record.ivars as { minimumPaidPrice?: number };
  if (memo.minimumPaidPrice !== undefined) return memo.minimumPaidPrice;
  const { link } = contextOf(record);
  const prices = await selectRows<{ price_cents: number | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${link.id} AND ${column("prices", "deleted_at")} IS NULL AND ${column("prices", "currency")} = ${link.price_currency_type}`,
  );
  if (prices.some((price) => (price.price_cents ?? 0) !== 0))
    throw notPorted("a product whose price differs from its row");
  memo.minimumPaidPrice = link.price_cents ?? 0;
  return memo.minimumPaidPrice;
}

const validateOfferCode: Callback<Purchase> = {
  name: "validate_offer_code",
  run(record) {
    if (record.errors.isEmpty() && record.get("offer_code_id" as never) != null) throw notPorted("an offer code");
  },
};

const priceNotTooLow: Callback<Purchase> = {
  name: "price_not_too_low",
  async run(record) {
    if (!record.errors.isEmpty()) return;
    const minPrice = 99; // USD: config/currencies.json "min_price" (a price of 0 is exempt for a customizable one)
    const displayed = record.get("displayed_price_cents") ?? 0;
    const { link } = contextOf(record);
    // customizable_price?: link.customizable_price? || (seller.tipping_enabled? && tip.present?) and no tip is present here
    if (link.customizable_price && displayed < minPrice && record.get("price_cents") !== 0) {
      addError(record, PurchaseErrorCode.CONTRIBUTION_TOO_LOW, "The amount must be at least $0.99.");
      return;
    }
    if (displayed >= (await minimumPaidPriceCents(record))) return;
    addError(
      record,
      PurchaseErrorCode.PRICE_CENTS_TOO_LOW,
      "Please enter an amount greater than or equal to the minimum.",
    );
  },
};

const priceNotTooHigh: Callback<Purchase> = {
  name: "price_not_too_high",
  run(record) {
    const { seller } = contextOf(record);
    const maxProductPrice = seller.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
    const price = record.get("price_cents");
    if (price == null || maxProductPrice === null || price <= maxProductPrice) return;
    addError(record, PurchaseErrorCode.PRICE_TOO_HIGH, "Sorry, we limit purchases to $5,000 at the moment.");
  },
};

const perceivedPriceMatches: Callback<Purchase> = {
  name: "perceived_price_cents_matches_price_cents",
  async run(record) {
    if (!record.errors.isEmpty()) return;
    const json = jsonDataOf(record);
    const perceived = json.perceived_price_cents as number | null | undefined;
    if (perceived == null) return;
    const minimum = await minimumPaidPriceCents(record);
    if ([minimum, minimum - 1].includes(perceived)) return;
    const { link } = contextOf(record);
    if (link.customizable_price && perceived >= minimum) return;
    addError(
      record,
      PurchaseErrorCode.PERCEIVED_PRICE_CENTS_NOT_MATCHING,
      "The price just changed! Refresh the page for the updated price.",
    );
  },
};

// Purchase#json_data (JsonData concern): the attributes the service stored as JSON.
function jsonDataOf(record: PurchaseRecord): Record<string, unknown> {
  const raw = record.get("json_data");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const validateSanctionedLocation: Callback<Purchase> = {
  name: "validate_sanctioned_location",
  run(record) {
    if (!record.errors.isEmpty()) return;
    const { geoInfo } = contextOf(record);
    const signals: [string | null | undefined, string | null | undefined][] = [
      [alpha2ByName(record.get("country")), record.get("state")],
      [alpha2ByName(record.get("ip_country")), record.get("ip_state")],
      [geoInfo?.countryCode, geoInfo?.regionName],
    ];
    if (!signals.some(([alpha2, subdivision]) => alpha2 && isBlockedLocation(alpha2, subdivision))) return;
    addError(
      record,
      PurchaseErrorCode.BLOCKED_SANCTIONED_LOCATION,
      "Sorry, this item is not available in your location.",
    );
  },
};

const validateQuantity: Callback<Purchase> = {
  name: "validate_quantity",
  run(record) {
    if (record.get("quantity") > 0) return;
    addError(record, PurchaseErrorCode.INVALID_QUANTITY, "Sorry, you've selected an invalid quantity.");
  },
};

const assignIsMultiseatLicense: Callback<Purchase> = {
  name: "assign_is_multiseat_license",
  run(record) {
    const { link } = contextOf(record);
    // link.multiseat_license_enabled?: the flag, for a product that is not a call
    const enabled = linkFlag(link, "is_multiseat_license") && link.native_type !== "call";
    record.set("flags", PurchaseFlags.set(record.get("flags"), "is_multiseat_license", enabled) as never);
  },
};

// Purchase::Risk#check_for_fraud, in order; each check stops at the first that adds an error.
const checkForFraud: Callback<Purchase> = {
  name: "check_for_fraud",
  async run(record, ctx) {
    const now = nowOf(ctx);
    const context = contextOf(record);
    const fail = (code: string, message: string) => addError(record, code, message);
    const free = record.get("price_cents") === 0 && (record.get("shipping_cents") ?? 0) === 0;

    // check_for_past_blocked_email_domains: the purchase's email, then the purchaser's
    for (const email of [record.get("email"), context.purchaserEmail]) {
      const domain = email ? mailAddressDomain(email) : null;
      if (domain && domain !== "parse_error" && (await emailDomainBlocked(now, domain))) {
        fail(
          PurchaseErrorCode.BLOCKED_EMAIL_DOMAIN,
          free ? "The transaction could not complete." : "Your card was not charged.",
        );
        return;
      }
    }

    // check_for_past_blocked_guids
    const guid = record.get("browser_guid");
    if (guid && (await activeBlockExists(now, guid))) {
      fail(PurchaseErrorCode.BLOCKED_BROWSER_GUID, BLOCKED_IDENTIFIER_ERROR);
      return;
    }

    // check_for_past_chargebacks: Purchase.excluding_paypal_processor.where(email:).chargedback.not_chargeback_reversed
    const chargedBack = await selectRows(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE (COALESCE(purchases.charge_processor_id, '') != 'paypal') AND ${column(PURCHASES, "email")} = ${record.get("email")} AND ${column(PURCHASES, "purchase_state")} = ${"successful"} AND (purchases.chargeback_date IS NOT NULL) AND ((${column(PURCHASES, "flags")} & 512 = 0)) ORDER BY ${column(PURCHASES, "chargeback_date")} DESC`,
    );
    const chargedBackByGuid = await selectRows(
      Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE (COALESCE(purchases.charge_processor_id, '') != 'paypal') AND (browser_guid is not null) AND ${column(PURCHASES, "browser_guid")} = ${guid} AND ${column(PURCHASES, "purchase_state")} = ${"successful"} AND (purchases.chargeback_date IS NOT NULL) AND ((${column(PURCHASES, "flags")} & 512 = 0)) ORDER BY ${column(PURCHASES, "chargeback_date")} DESC`,
    );
    if (chargedBack.length + chargedBackByGuid.length > 0) throw notPorted("a buyer with a chargeback");

    // check_for_past_fraudulent_buyers: User.find_by(email:), which the service already ran when the email is unchanged
    let buyer = context.buyerByEmail;
    if (context.buyerLookupEmail !== undefined && context.buyerLookupEmail !== record.get("email")) {
      const [row] = await selectRows<User>(
        Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "email")} = ${record.get("email")} LIMIT 1`,
      );
      buyer = row ? castRow<User>("User", row as never) : null;
    }
    if (buyer?.user_risk_state === "suspended_for_fraud") {
      fail("suspended_buyer", "Your card was not charged.");
      return;
    }
    // check_for_past_fraudulent_ips returns for a free purchase
    if (!free) throw notPorted("a priced purchase's IP checks");
  },
};

const toggleOffCanContactIfBuyerHasUnsubscribed: Callback<Purchase> = {
  name: "toggle_off_can_contact_if_buyer_has_unsubscribed",
  async run(record) {
    if (!record.newRecord || !record.get("can_contact")) return;
    const rows = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "email")} = ${record.get("email")} AND ${column(PURCHASES, "seller_id")} = ${record.get("seller_id")} AND ${column(PURCHASES, "can_contact")} = FALSE LIMIT 1`,
    );
    if (rows.length === 0) return;
    // can_contact_reason = CAN_CONTACT_REASON_INHERITED lives in a column this model does not carry yet
    throw notPorted("a buyer who unsubscribed from the seller");
  },
};

// ---- before_save / after_save / after_commit --------------------------------------------------------------------

const truncateReferrer: Callback<Purchase> = {
  name: "truncate_referrer",
  run(record) {
    const referrer = record.get("referrer");
    if (referrer) record.set("referrer", [...referrer].slice(0, 191).join(""));
  },
};

// Purchase.inventory_pending_create_commit_ids: ids saved in the open transaction whose counters are not synced yet
const pendingCreateCommitIds = new Set<bigint>();

// COUNTS_TOWARDS_INVENTORY_STATES
const COUNTS_TOWARDS_INVENTORY_STATES = [
  "preorder_authorization_successful",
  "in_progress",
  "successful",
  "not_charged",
];

const syncInventoryCountersOnCreate: Callback<Purchase> = {
  name: "sync_inventory_counter_caches_on_create",
  on: "create",
  async run(record) {
    pendingCreateCommitIds.delete(record.get("id"));
    const flags = record.get("flags");
    const countsTowardsInventory =
      COUNTS_TOWARDS_INVENTORY_STATES.includes(record.get("purchase_state") ?? "") &&
      !PurchaseFlags.isSet(flags, "is_additional_contribution") &&
      !PurchaseFlags.isSet(flags, "is_archived_original_subscription_purchase") &&
      record.get("subscription_id") == null;
    const delta = record.get("quantity");
    if (!countsTowardsInventory || delta === 0) return;
    // variant_attribute_ids is empty here: a purchase with variants is refused before the first write
    if (record.get("link_id") != null)
      await execute(
        Prisma.sql`UPDATE ${table("links")} SET sales_count_for_inventory_cache = sales_count_for_inventory_cache + ${Prisma.raw(String(delta))} WHERE ${column("links", "id")} = ${record.get("link_id")}`,
      );
  },
};

// ---- update-side hooks: audience projection, search index, inventory counters, order outcome ----------------------------

const ORDER_OUTCOME_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "test_successful",
  "failed",
  "preorder_authorization_failed",
  "gift_receiver_purchase_failed",
];
const SUCCESSFUL_STATES_FOR_RELATED_DOCUMENTS = [
  "successful",
  "gift_receiver_purchase_successful",
  "preorder_authorization_successful",
];
// Purchase::AudienceMember::AUDIENCE_MEMBER_WATCHED_ATTRIBUTES
const AUDIENCE_MEMBER_WATCHED_ATTRIBUTES = [
  "can_contact",
  "purchase_state",
  "stripe_refunded",
  "flags",
  "chargeback_date",
  "email",
];
// Purchase::Searchable::ATTRIBUTE_TO_SEARCH_FIELDS
const ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string[]> = {
  id: ["id"],
  can_contact: ["can_contact"],
  chargeback_date: ["chargeback_date", "not_chargedback_or_chargedback_reversed"],
  country: ["country_or_ip_country"],
  created_at: ["created_at"],
  email: ["email", "email_domain", "subscription_current_email", "subscription_current_email_domain"],
  fee_cents: ["fee_cents"],
  flags: [
    "selected_flags",
    "not_chargedback_or_chargedback_reversed",
    "not_subscription_or_original_subscription_purchase",
    "referrer_domain",
  ],
  full_name: ["full_name"],
  ip_country: ["country_or_ip_country", "ip_country"],
  ip_state: ["ip_state"],
  referrer: ["referrer_domain"],
  price_cents: ["price_cents"],
  purchase_state: ["purchase_state", "latest_charge_date", "successful_authorization_or_without_preorder"],
  stripe_refunded: ["stripe_refunded", "not_refunded_except_subscriptions"],
  tax_cents: ["tax_cents"],
  card_visual: ["paypal_email"],
  subscription_id: ["subscription_id"],
  license_serial: ["license_serial"],
  license_uses: ["license_uses"],
  purchaser_id: ["purchaser_id"],
};
// ElasticsearchModelAsyncCallbacks: `4.seconds` for an update
const ELASTICSEARCH_UPDATE_DELAY_SECONDS_ON_UPDATE = 4;
// ElasticsearchIndexerWorker.perform_in(rand(72.hours)) spreads the related-purchase documents over three days
const RELATED_DOCUMENTS_SPREAD_SECONDS = 72 * 60 * 60;
const SYNC_INVENTORY_ATTRIBUTES = ["purchase_state", "flags", "subscription_id", "quantity"];

const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const committedAttributes = (record: PurchaseRecord) => (record.ivars[COMMITTED] as string[] | undefined) ?? [];
const stateJustChanged = (record: PurchaseRecord) => record.savedChanges.purchase_state !== undefined;

const trackChangedAttributes: Callback<Purchase> = {
  name: "TransactionalAttributeChangeTracker after_save",
  run(record) {
    record.ivars[COMMITTED] = null;
    const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
    for (const name of Object.keys(record.savedChanges)) changed.add(name);
  },
};

type AudienceMemo = { audienceRefreshNeeded?: boolean; audienceOldEmail?: string | null; createdThisSave?: boolean };

const recordAudienceMemberRefreshTrigger: Callback<Purchase> = {
  name: "record_audience_member_refresh_trigger",
  run(record) {
    const memo = record.ivars as AudienceMemo;
    const createdThisSave = memo.createdThisSave === true;
    memo.createdThisSave = false;
    if (!Object.keys(record.savedChanges).some((name) => AUDIENCE_MEMBER_WATCHED_ATTRIBUTES.includes(name))) return;
    memo.audienceRefreshNeeded = true;
    if (record.savedChanges.email !== undefined && !createdThisSave)
      memo.audienceOldEmail ??= record.savedChanges.email[0] as string | null;
  },
};

const scheduleAudienceMemberRefresh: Callback<Purchase> = {
  // Purchase::AudienceMember#schedule_audience_member_refresh_if_changed
  name: "schedule_audience_member_refresh_if_changed",
  on: ["create", "update"],
  async run(record) {
    const memo = record.ivars as AudienceMemo;
    if (!memo.audienceRefreshNeeded) return;
    const oldEmail = memo.audienceOldEmail ?? null;
    memo.audienceRefreshNeeded = false;
    memo.audienceOldEmail = null;
    const sellerId = record.get("seller_id");
    if (oldEmail)
      await afterCommitEverywhere(async () => {
        await performAsync("RefreshAudienceMemberJob", [oldEmail, sellerId] as never);
      });
    await afterCommitEverywhere(async () => {
      await performAsync("RefreshAudienceMemberJob", [record.get("email"), sellerId] as never);
    });
  },
};

type InventorySnapshot = {
  purchase_state: string | null;
  flags: bigint | number;
  quantity: number;
  subscription_id: bigint | null;
  subscription_deactivated_at: Date | null;
};

// `Subscription.where(id:).pick(:deactivated_at)`
async function subscriptionDeactivatedAt(id: bigint): Promise<Date | null> {
  const [row] = await selectRows<{ deactivated_at: Date | null }>(
    Prisma.sql`SELECT ${column("subscriptions", "deactivated_at")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${id} LIMIT 1`,
  );
  return row?.deactivated_at ?? null;
}

const snapshotInventoryPreSaveState: Callback<Purchase> = {
  name: "snapshot_inventory_pre_save_state",
  async run(record) {
    if (record.newRecord) return;
    const memo = record.ivars as { inventorySnapshot?: InventorySnapshot | null };
    if (memo.inventorySnapshot) return;
    // These reads leave PaperTrail's `object` in column order for a purchase loaded with `find` (purchase-seller-balance.golden.json)
    const read = record.untracked(() => ({
      purchase_state: record.attributeInDatabase("purchase_state"),
      flags: record.attributeInDatabase("flags"),
      quantity: record.attributeInDatabase("quantity"),
      subscription_id: record.attributeInDatabase("subscription_id"),
    }));
    memo.inventorySnapshot = {
      ...read,
      subscription_deactivated_at:
        read.subscription_id != null ? await subscriptionDeactivatedAt(read.subscription_id) : null,
    };
  },
};

// Purchase.counts_towards_inventory_for?
function countsTowardsInventory(
  state: string | null,
  flags: bigint | number,
  subscriptionId: bigint | null,
  subscriptionDeactivatedAt: Date | null,
): boolean {
  if (!COUNTS_TOWARDS_INVENTORY_STATES.includes(state ?? "")) return false;
  if (PurchaseFlags.isSet(flags, "is_additional_contribution")) return false;
  if (PurchaseFlags.isSet(flags, "is_archived_original_subscription_purchase")) return false;
  if (subscriptionId != null) {
    if (
      !PurchaseFlags.isSet(flags, "is_original_subscription_purchase") &&
      !PurchaseFlags.isSet(flags, "is_gift_receiver_purchase")
    )
      return false;
    if (subscriptionDeactivatedAt != null) return false;
  }
  return true;
}

const syncInventoryCounterCacheForStateChange: Callback<Purchase> = {
  name: "sync_inventory_counter_cache_for_state_change",
  on: "update",
  async run(record) {
    const memo = record.ivars as { inventorySnapshot?: InventorySnapshot | null };
    const snapshot = memo.inventorySnapshot;
    if (!snapshot) return;
    if (!Object.keys(record.savedChanges).some((name) => SYNC_INVENTORY_ATTRIBUTES.includes(name))) return;
    const before = countsTowardsInventory(
      snapshot.purchase_state,
      snapshot.flags,
      snapshot.subscription_id,
      snapshot.subscription_deactivated_at,
    )
      ? snapshot.quantity
      : 0;
    const subscriptionId = record.get("subscription_id");
    const afterDeactivatedAt = subscriptionId != null ? await subscriptionDeactivatedAt(subscriptionId) : null;
    const after = countsTowardsInventory(
      record.get("purchase_state"),
      record.get("flags"),
      subscriptionId,
      afterDeactivatedAt,
    )
      ? record.get("quantity")
      : 0;
    const delta = after - before;
    memo.inventorySnapshot = null;
    if (delta === 0) return;
    if (record.get("link_id") != null)
      await execute(
        Prisma.sql`UPDATE ${table("links")} SET sales_count_for_inventory_cache = sales_count_for_inventory_cache + ${Prisma.raw(String(delta))} WHERE ${column("links", "id")} = ${record.get("link_id")}`,
      );
  },
};

const recordOrderChargeOutcome: Callback<Purchase> = {
  name: "enqueue_record_order_charge_outcome",
  async run(record) {
    if (!stateJustChanged(record) || !ORDER_OUTCOME_STATES.includes(record.get("purchase_state") ?? "")) return;
    const orderId = contextOf(record).orderId;
    if (orderId != null) await performAsync("RecordOrderChargeOutcomeJob", [orderId] as never);
  },
};

const refreshHighVolumeFeeEligibility: Callback<Purchase> = {
  name: "enqueue_high_volume_fee_eligibility_refresh",
  async run(record) {
    if (!stateJustChanged(record) || record.get("purchase_state") !== "successful") return;
    const sellerId = record.get("seller_id");
    if (sellerId == null) return;
    if (!(await effectsOf(record).featureActive("high_volume_seller_fee", `User;${sellerId}`))) return;
    throw notPorted("a seller on the high-volume fee");
  },
};

const enqueueUpdateSalesRelatedProductsInfos: Callback<Purchase> = {
  name: "enqueue_update_sales_related_products_infos_job",
  async run(record) {
    if (!stateJustChanged(record) || record.get("purchase_state") !== "successful") return;
    await performAsync("UpdateSalesRelatedProductsInfosJob", [record.get("id"), true] as never);
  },
};

const updateRelatedPurchaseDocuments: Callback<Purchase> = {
  // Purchase::Searchable::RelatedPurchaseCallbacks#update_related_purchase_documents
  name: "update_related_purchase_documents",
  on: ["create", "update"],
  async run(record) {
    if (!SUCCESSFUL_STATES_FOR_RELATED_DOCUMENTS.includes(record.get("purchase_state") ?? "")) return;
    // Ruby's `successful_states.include?(previous_changes[:purchase_state])` compares Strings with an Array, so it never returns here
    if (!stateJustChanged(record)) return;
    const query = new PurchaseSearchService({
      seller: record.get("seller_id"),
      email: record.get("email"),
      exclude_purchase: record.get("id"),
    }).body.query;
    await performAsync(
      "ElasticsearchIndexerWorker",
      [
        "update_by_query",
        {
          source_record_id: record.get("id"),
          query,
          class_name: "Purchase",
          fields: [
            "product_ids_from_same_seller_purchased_by_purchaser",
            "variant_ids_from_same_seller_purchased_by_purchaser",
          ],
        },
      ] as never,
      { queue: "low", delaySeconds: effectsOf(record).randomDelaySeconds(RELATED_DOCUMENTS_SPREAD_SECONDS) },
    );
  },
};

const updateSamePurchaserSubscriptionPurchaseDocuments: Callback<Purchase> = {
  name: "update_same_purchaser_subscription_purchase_documents",
  on: ["create", "update"],
  async run(record) {
    if (record.get("subscription_id") == null) return;
    // Only a refund's save loads the subscription this callback reads; a purchase created for one is not served
    const held = heldSubscription(record);
    if (held === undefined || record.newRecord) throw notPorted("a purchase that belongs to a subscription");
    // `should_update &= subscription.present? && subscription.original_purchase.present?` evaluates its right side whatever the left says
    const original = held.subscription === null ? null : await subscriptionView(held.subscription).originalPurchase();
    const shouldUpdate =
      record.get("purchase_state") === "successful" &&
      record.savedChanges.purchase_state !== undefined &&
      !flag(record, "is_original_subscription_purchase") &&
      original !== null;
    if (shouldUpdate) throw notPorted("a subscription charge that just became successful");
  },
};

// User::HIGH_VOLUME_FEE_THRESHOLD_CENTS
const HIGH_VOLUME_FEE_THRESHOLD_CENTS = 2_000_000;

// after_commit :refresh_high_volume_fee_eligibility, if: stripe_refunded_previously_changed? (User#refresh_high_volume_fee_eligibility!).
// A seller whose eligibility month would change is not served: Ruby saves the user there, and this commit hook has no way to
// hand back, so the refund that gets here must have checked `high_volume_fee_month` before it wrote.
const refreshHighVolumeFeeEligibilityAfterRefund: Callback<Purchase> = {
  name: "refresh_high_volume_fee_eligibility",
  async run(record, ctx) {
    if (record.savedChanges.stripe_refunded === undefined) return;
    const seller = Users.load(contextOf(record).seller);
    await Users.reload(seller);
    await Users.withLock(seller, async () => {
      const startOfMonth = new Date(ctx.now?.() ?? new Date());
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);
      const [row] = await selectRows(
        Prisma.sql`SELECT SUM(${column(PURCHASES, "price_cents")}) FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "seller_id")} = ${seller.get("id")} AND ${column(PURCHASES, "purchase_state")} = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) AND (purchases.created_at >= ${startOfMonth})`,
      );
      const eligible = Number(Object.values(row ?? {})[0] ?? 0) >= HIGH_VOLUME_FEE_THRESHOLD_CENTS;
      if (eligible || userJsonDataForAttr(seller, "high_volume_fee_month") !== null)
        throw notPorted("a seller whose high-volume fee month changes with a refund");
    });
  },
};

const sendToElasticsearchOnUpdate: Callback<Purchase> = {
  name: "send_to_elasticsearch(update)",
  on: "update",
  async run(record) {
    const fields = [...new Set(committedAttributes(record).flatMap((name) => ATTRIBUTE_TO_SEARCH_FIELDS[name] ?? []))];
    if (fields.length === 0) return;
    await performAsync(
      "ElasticsearchIndexerWorker",
      ["update", { record_id: record.get("id"), class_name: "Purchase", fields } as never],
      { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS_ON_UPDATE },
    );
  },
};

const markCreatedThisSave: Callback<Purchase> = {
  name: "previously_new_record?",
  run(record) {
    record.ivars.createdThisSave = true;
  },
};

// before_save :schedule_product_search_refresh_after_refund: a refund that flips stripe_refunded to or from true reindexes the product's
// recommendability after the commit.
const scheduleProductSearchRefreshAfterRefund: Callback<Purchase> = {
  name: "schedule_product_search_refresh_after_refund",
  async run(record) {
    // untracked: reading an attribute must not change the order PaperTrail serializes them in
    const change = record.untracked(() =>
      record.attributeChanged("stripe_refunded") ? record.changes().stripe_refunded! : null,
    );
    if (change === null || (change[0] === true) === (change[1] === true)) return;
    const linkId = record.get("link_id");
    await afterCommitEverywhere(async () => {
      await performAsync("SendToElasticsearchWorker", [linkId, "update", ["is_recommendable"]] as never);
    });
  },
};

type ReviewHolder = { productReviewLoaded?: boolean };

const paperTrail = hasPaperTrail<Purchase>("Purchase", { itemType: "Purchase" });

export const Purchases = defineModel<Purchase>({
  rubyClass: "Purchase",
  prismaModel: "Purchase",
  delegate: (tx) => tx.purchase as never,
  afterCreate: [
    ...paperTrail.afterCreate,
    markCreatedThisSave,
    {
      // after_create :mark_inventory_new_in_txn
      name: "mark_inventory_new_in_txn",
      run(record) {
        pendingCreateCommitIds.add(record.get("id"));
      },
    },
    {
      // has_one :purchase_url_parameter, declared ahead of the refund policy
      name: "save_has_one_association purchase_url_parameter",
      async run(record, ctx) {
        const params = contextOf(record).urlParametersToSave;
        if (!params) return;
        const child = PurchaseUrlParameters.build({ purchase_id: record.get("id"), params } as never);
        setAssociation(child, "purchase", record.get("id"), record.attributes as never);
        await PurchaseUrlParameters.saveBang(child, { now: ctx.now });
      },
    },
    {
      // has_one :purchase_refund_policy: the child is saved after the parent, with its own validations
      name: "save_has_one_association purchase_refund_policy",
      async run(record, ctx) {
        const snapshot = contextOf(record).refundPolicy;
        if (!snapshot) return;
        const child = PurchaseRefundPolicies.build({
          purchase_id: record.get("id"),
          max_refund_period_in_days: snapshot.max_refund_period_in_days,
          title: snapshot.title,
          fine_print: snapshot.fine_print,
        });
        setAssociation(child, "purchase", record.get("id"), record.attributes as never);
        await PurchaseRefundPolicies.saveBang(child, { now: ctx.now });
      },
    },
  ],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeValidation: [strippedEmail],
  validations: [
    // declared with the state machine, ahead of the `validate` lines
    financialTransactionValidation,
    mustHaveValidEmail,
    notDoubleCharged,
    sellerIsLinkUser,
    presence(["seller_id"]),
    presence(["price_cents"]),
    presence(["total_transaction_cents"]),
    presence(["fee_cents"]),
    giftRecipientHiddenNeedsPurchaser,
    customFeePerThousand,
  ],
  beforeSave: [
    // JsonData: a persisted purchase's json_data delta is rebased onto the row (the `FOR UPDATE` read)
    mergeJsonDataWithCurrentRow("purchases", { keepAttributeOrder: true }),
    {
      // assign_default_rental_expired: is_rental did not change for a purchase that is not a rental
      name: "assign_default_rental_expired",
      run() {},
    },
    truncateReferrer,
    snapshotInventoryPreSaveState,
    scheduleProductSearchRefreshAfterRefund,
  ],
  beforeCreate: [
    productIsSellable,
    freeProductIpAddressIsNotBlocked,
    {
      // product_is_not_blocked returns for a free purchase
      name: "product_is_not_blocked",
      run() {},
    },
    {
      // validate_purchase_type: neither a rental nor a rent-only product reaches here
      name: "validate_purchase_type",
      run() {},
    },
    variantsAvailable,
    variantsSatisfied,
    {
      // sold_out returns for a product without max_purchase_count
      name: "sold_out",
      run() {},
    },
    validateOfferCode,
    priceNotTooLow,
    priceNotTooHigh,
    perceivedPriceMatches,
    {
      // validate_subscription returns for a purchase that is not a recurring charge
      name: "validate_subscription",
      run() {},
    },
    {
      // validate_shipping returns for a product that is not physical
      name: "validate_shipping",
      run() {},
    },
    validateSanctionedLocation,
    validateQuantity,
    assignIsMultiseatLicense,
    checkForFraud,
    toggleOffCanContactIfBuyerHasUnsubscribed,
  ],
  beforeCommit: [
    {
      name: "TransactionalAttributeChangeTracker before_commit",
      run(record) {
        const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
        if (changed === undefined) return;
        record.ivars[COMMITTED] = [...changed];
        changed.clear();
      },
    },
  ],
  afterSave: [
    recordAudienceMemberRefreshTrigger,
    trackChangedAttributes,
    {
      // Purchase::Reviews#update_product_review_stat: reads the purchase's review (none for a new purchase)
      name: "update_product_review_stat",
      async run(record) {
        if (Object.keys(record.savedChanges).length === 0) return;
        // original_product_review: the purchase's (a gift sender's: its giftee's) true original purchase's `product_review`, a has_one
        // that is loaded once per instance
        let purchase: PurchaseRecord | null = record;
        if (flag(record, "is_gift_sender_purchase")) {
          const held = heldGiftGiven(record);
          if (held === undefined) throw notPorted("a gift sender that has not loaded its gift");
          purchase = held.giftee;
        }
        if (purchase === null) return;
        let holder = purchase.ivars as ReviewHolder;
        let reviewedId = purchase.get("id");
        if (purchase.get("subscription_id") != null) {
          const subscription = heldSubscription(purchase)?.subscription;
          if (subscription === undefined || subscription === null)
            throw notPorted("a purchase that belongs to a subscription");
          const original = await subscriptionView(subscription).loaded("true_original_purchase", async () => {
            const [row] = await selectRows<Purchase>(
              Prisma.sql`SELECT ${star} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "subscription_id")} = ${subscription.get("id")} AND (${PurchaseFlags.condition("is_original_subscription_purchase", true)}) ORDER BY ${column(PURCHASES, "id")} ASC LIMIT 1`,
            );
            return { row: row ?? null, review: {} as ReviewHolder };
          });
          if (original.row === null) return;
          holder = original.review;
          reviewedId = original.row.id;
        }
        if (holder.productReviewLoaded) return;
        holder.productReviewLoaded = true;
        const rows = await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`product_reviews`.*")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${reviewedId} LIMIT 1`,
        );
        if (rows.length > 0) throw notPorted("a purchase that already has a review");
      },
    },
  ],
  // Declared in Ruby's order; the runtime runs them reversed.
  afterCommit: [
    scheduleAudienceMemberRefresh,
    {
      // ElasticsearchModelAsyncCallbacks: after_commit send_to_elasticsearch("index"), on: :create
      name: "send_to_elasticsearch(index)",
      on: "create",
      async run(record) {
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["index", { record_id: record.get("id"), class_name: "Purchase" } as never],
          {
            delaySeconds: ELASTICSEARCH_INDEX_DELAY_SECONDS,
          },
        );
      },
    },
    sendToElasticsearchOnUpdate,
    updateRelatedPurchaseDocuments,
    updateSamePurchaserSubscriptionPurchaseDocuments,
    enqueueUpdateSalesRelatedProductsInfos,
    refreshHighVolumeFeeEligibility,
    refreshHighVolumeFeeEligibilityAfterRefund,
    recordOrderChargeOutcome,
    syncInventoryCountersOnCreate,
    syncInventoryCounterCacheForStateChange,
  ],
});
