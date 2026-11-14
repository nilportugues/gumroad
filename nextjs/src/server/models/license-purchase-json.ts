// The `purchase` of a license response in Api::V2::LicensesController#success_with_license:
// `purchase.payload_for_ping_notification.merge(purchase_as_json(purchase))`, where the second hash is the WHITELIST_PURCHASE_ATTRIBUTES
// slice of `Purchase#as_json_for_license`. Several variants, a shipped product or
// a gifted membership raises NotPortedError before anything is written, and the dispatcher hands the request to Rails.
import { Prisma } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { findLink, findUserById, type LinkRow, type UserRow } from "../presenters/product-reads.ts";
import { longUrl } from "../presenters/product.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { moneyFormatWithGemSymbol } from "./concerns/money-formatter.ts";
import { LinkFlags } from "./link.ts";
import { castBoolean, directAffiliateFields, ownAffiliateCreditCents, timeJson } from "./purchase-json.ts";
import { column, selectRows, table } from "./sql.ts";
import { SubscriptionFlags } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RUBY_REF = "Purchase#payload_for_ping_notification";
const notPorted = (what: string) => new NotPortedError(what, RUBY_REF);
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const truthy = (value: unknown): boolean => value === true || value === 1 || value === 1n;

const exists = async (
  tableName: string,
  columnName: string,
  id: unknown,
  extra: Prisma.Sql = Prisma.empty,
): Promise<boolean> =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, columnName)} = ${id}${extra} LIMIT 1`,
    )
  ).length > 0;

export const findPurchaseRow = async (id: unknown): Promise<Row | null> =>
  (
    await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
    )
  )[0] ?? null;

// Subscription#recurrence for a plain payment option: `last_payment_option`, else the latest alive one.
async function subscriptionRecurrence(subscription: Row): Promise<string> {
  if (SubscriptionFlags.isSet(subscription.flags, "is_installment_plan"))
    throw notPorted("an installment plan subscription");
  const options = await selectRows<Row>(
    subscription.last_payment_option_id == null
      ? Prisma.sql`SELECT ${Prisma.raw("`payment_options`.*")} FROM ${table("payment_options")} WHERE ${column("payment_options", "subscription_id")} = ${subscription.id} AND ${column("payment_options", "deleted_at")} IS NULL ORDER BY ${column("payment_options", "id")} DESC LIMIT 1`
      : Prisma.sql`SELECT ${Prisma.raw("`payment_options`.*")} FROM ${table("payment_options")} WHERE ${column("payment_options", "id")} = ${subscription.last_payment_option_id} LIMIT 1`,
  );
  const option = options[0];
  if (option === undefined || option.product_installment_plan_id != null || option.price_id == null)
    throw notPorted("a subscription with no plain price");
  const [price] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table("prices")} WHERE ${column("prices", "id")} = ${option.price_id} LIMIT 1`,
  );
  if (price === undefined) throw notPorted("a subscription with no price");
  return price.recurrence;
}

const BASE_VARIANT_IS_DEFAULT_SKU = 1;

// `purchase.variant_attributes` as one tier of a Variant row. Several variants (the join has no order) stay with Rails. A SKU is
// named by its row, and the default SKU is not displayed; the ping payload's `variants` hash is replaced by the string either way.
type SingleVariant = { title: string; name: string; sku?: { id: string; custom: string | null }; hidden?: boolean };
async function singleVariant(purchase: Row): Promise<SingleVariant | null> {
  const joins = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants_purchases`.*")} FROM ${table("base_variants_purchases")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id}`,
  );
  if (joins.length === 0) return null;
  if (joins.length > 1) throw notPorted("several variants");
  const [variant] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${joins[0]!.base_variant_id} LIMIT 1`,
  );
  if (variant === undefined) throw notPorted("a variant row that is gone");
  if (variant.type === "Sku") {
    const hidden = (Number(variant.flags ?? 0) & BASE_VARIANT_IS_DEFAULT_SKU) !== 0;
    if (!hidden && variant.name === "Untitled") throw notPorted("a SKU named Untitled");
    return {
      title: "",
      name: variant.name,
      sku: { id: encrypt(variant.id), custom: present(variant.custom_sku) ? variant.custom_sku : null },
      hidden,
    };
  }
  if ((Number(variant.flags ?? 0) & BASE_VARIANT_IS_DEFAULT_SKU) !== 0) throw notPorted("a default SKU");
  const [category] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "id")} = ${variant.variant_category_id} LIMIT 1`,
  );
  if (category === undefined) throw notPorted("a variant with no category");
  return { title: category.title, name: variant.name };
}

// ProductsHelper#variants_displayable
const variantsDisplayable = (name: string): string => (name === "Untitled" ? "" : `(${name})`);

// `Purchase#custom_fields`, each value cast as PurchaseCustomField#value does.
async function customFieldsOf(purchase: Row): Promise<{ name: string; value: string | boolean | null }[]> {
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_custom_fields`.*")} FROM ${table("purchase_custom_fields")} WHERE ${column("purchase_custom_fields", "purchase_id")} = ${purchase.id} ORDER BY ${column("purchase_custom_fields", "id")} ASC`,
  );
  return rows.map((field) => {
    // `__proto__` is not an own key of a JS object literal; a numeric key only moves in the serialized object, which clients read unordered.
    if (field.name === "__proto__") throw notPorted("a custom field whose name is not an ordinary key");
    const boolean = field.field_type === "checkbox" || field.field_type === "terms";
    return { name: field.name, value: boolean ? castBoolean(field.value) : String(field.value ?? "") };
  });
}

type OfferCodeJson = { code: string; displayed_amount_off: string; name: string };

// The `offer_code` of `Purchase#as_json`: the discount as the buyer got it (the cached PurchaseOfferCodeDiscount), else the offer
// code row. The amount is formatted by the money gem itself, which `moneyFormatWithGemSymbol` ports.
async function offerCodeJson(purchase: Row, link: LinkRow): Promise<OfferCodeJson | null> {
  const [offerCode] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`offer_codes`.*")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${purchase.offer_code_id} LIMIT 1`,
  );
  if (offerCode === undefined) return null;
  const [cached] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_offer_code_discounts`.*")} FROM ${table("purchase_offer_code_discounts")} WHERE ${column("purchase_offer_code_discounts", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  let cents: number | null;
  let percentage: number | null;
  if (cached === undefined) {
    cents = offerCode.amount_cents == null ? null : Number(offerCode.amount_cents);
    percentage = offerCode.amount_percentage == null ? null : Number(offerCode.amount_percentage);
  } else {
    const [original] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`offer_codes`.*")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${cached.offer_code_id} LIMIT 1`,
    );
    if (original === undefined) throw notPorted("a discount whose offer code is gone");
    const isPercent = truthy(cached.offer_code_is_percent);
    cents = isPercent ? null : Number(cached.offer_code_amount);
    percentage = isPercent ? Number(cached.offer_code_amount) : null;
  }
  const displayed =
    cents === null
      ? `${percentage ?? ""}%`
      : moneyFormatWithGemSymbol(cents, String(link.price_currency_type), { noCentsIfWhole: true });
  return { code: offerCode.code, displayed_amount_off: displayed, name: offerCode.code };
}

// The `affiliate` and `affiliate_credit_amount_cents` keys of the ping payload. The credit key needs a non-direct AffiliateCredit row
// (`purchase.affiliate_credit`), the email an Affiliate row; either can exist without the other.
async function affiliatePayload(
  purchase: Row,
): Promise<{ named: boolean; email: string | null; creditCents: number | null }> {
  const hasCredit = await exists(
    "affiliate_credits",
    "purchase_id",
    purchase.id,
    Prisma.sql` AND is_direct_affiliate_credit = 0`,
  );
  const [affiliate] =
    purchase.affiliate_id == null
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${purchase.affiliate_id} LIMIT 1`,
        );
  let email: string | null = null;
  if (affiliate !== undefined) {
    const [user] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${affiliate.affiliate_user_id} LIMIT 1`,
    );
    if (user === undefined) throw notPorted("an affiliate whose user row is missing");
    // User#form_email
    email = present(user.unconfirmed_email) ? user.unconfirmed_email : present(user.email) ? user.email : null;
  }
  let creditCents: number | null = null;
  if (hasCredit) {
    const directId = directAffiliateFields(purchase).id;
    const [direct] =
      directId === null
        ? []
        : await selectRows<Row>(
            Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${directId} LIMIT 1`,
          );
    creditCents = ownAffiliateCreditCents(purchase, affiliate, direct);
  }
  return { named: affiliate !== undefined, email, creditCents };
}

export async function licensePurchaseJson(purchase: Row, license: Row): Promise<Record<string, unknown>> {
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const link: LinkRow | null = purchase.link_id == null ? null : await findLink(purchase.link_id);
  const seller: UserRow | null = purchase.seller_id == null ? null : await findUserById(purchase.seller_id);
  const purchaser: UserRow | null = purchase.purchaser_id == null ? null : await findUserById(purchase.purchaser_id);
  if (link === null || seller === null) throw notPorted("a purchase without a product or seller");

  const giftReceiver = flags("is_gift_receiver_purchase");
  if (giftReceiver && flags("is_gift_sender_purchase")) throw notPorted("a gift sent and received at once");
  // Purchase#gift: gift_received for a receiver; a missing row or a gifted membership stays with Rails
  let gift: { price: unknown; gifterEmail: unknown } | null = null;
  if (giftReceiver) {
    const [received] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`gifts`.*")} FROM ${table("gifts")} WHERE ${column("gifts", "giftee_purchase_id")} = ${purchase.id} LIMIT 1`,
    );
    if (received === undefined || purchase.subscription_id != null)
      throw notPorted("a gift purchase without a gift row");
    const [gifter] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${received.gifter_purchase_id} LIMIT 1`,
    );
    if (gifter === undefined) throw notPorted("a gift whose gifter purchase is gone");
    gift = { price: gifter.price_cents, gifterEmail: gifter.email };
  }
  if (flags("is_gift_sender_purchase") && purchase.subscription_id != null) throw notPorted("a gifted membership");
  if (LinkFlags.isSet(link.flags, "is_physical") || truthy(link.require_shipping)) throw notPorted("a shipped product");
  const affiliate = await affiliatePayload(purchase);
  const variant = await singleVariant(purchase);
  const customFields = await customFieldsOf(purchase);
  const offerCode = purchase.offer_code_id == null ? null : await offerCodeJson(purchase, link);

  const recurringBilling = LinkFlags.isSet(link.flags, "is_recurring_billing");
  let subscription: Row | null = null;
  let subscriptionCustomFields: { name: string; value: string | boolean | null }[] = [];
  if (purchase.subscription_id != null) {
    [subscription = null] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${purchase.subscription_id} LIMIT 1`,
    );
    if (subscription === null) throw notPorted("a purchase whose subscription is gone");
    // The ping reads `subscription.custom_fields` (those of its original purchase) when the purchase has none.
    if (customFields.length === 0) {
      const originals = await selectRows<Row>(
        Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id} AND ${PurchaseFlags.condition("is_original_subscription_purchase", true)} AND ${PurchaseFlags.condition("is_archived_original_subscription_purchase", false)} ORDER BY ${column("purchases", "id")} ASC LIMIT 2`,
      );
      // has_one without an order picks a row MySQL chooses
      if (originals.length > 1) throw notPorted("a subscription with several original purchases");
      if (originals[0] !== undefined) subscriptionCustomFields = await customFieldsOf(originals[0]);
    }
  } else if (recurringBilling) {
    throw notPorted("a recurring product purchase without a subscription");
  }

  // `purchase.license`: the has_one the key is read from; it can differ from the license the request found.
  const [own] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "purchase_id")} = ${purchase.id} ORDER BY ${column("licenses", "id")} ASC LIMIT 1`,
  );
  const licensed = LinkFlags.isSet(link.flags, "is_licensed");
  if (licensed && own !== undefined && String(own.id) !== String(license.id))
    throw notPorted("a purchase with another license");
  const licenseKey = licensed && own !== undefined && present(own.serial) ? own.serial : null;

  const stripeRefunded = purchase.stripe_refunded == null ? null : truthy(purchase.stripe_refunded);
  const chargedBack = purchase.chargeback_date != null;
  const reversed = flags("chargeback_reversed");
  const payload: Record<string, unknown> = {
    seller_id: encrypt(seller.id),
    product_id: encrypt(link.id),
    product_name: link.name,
    permalink: present(link.custom_permalink) ? link.custom_permalink : link.unique_permalink,
    product_permalink: longUrl(link, seller),
    short_product_id: link.unique_permalink,
    email: purchase.email,
    price: purchase.price_cents,
    gumroad_fee: purchase.fee_cents,
    currency: link.price_currency_type,
    quantity: purchase.quantity,
    discover_fee_charged: flags("was_discover_fee_charged"),
    can_contact: truthy(purchase.can_contact),
    referrer: purchase.referrer,
    card: { visual: purchase.card_visual, type: purchase.card_type, bin: null, expiry_month: null, expiry_year: null },
    order_number: encryptNumeric(Number(purchase.id)),
    sale_id: encrypt(purchase.id),
    sale_timestamp: timeJson(purchase.created_at),
  };
  if (present(purchase.full_name)) payload.full_name = purchase.full_name;
  if (purchaser !== null) payload.purchaser_id = purchaser.external_id;
  if (subscription !== null) payload.subscription_id = encrypt(subscription.id);
  if (affiliate.creditCents !== null) payload.affiliate_credit_amount_cents = affiliate.creditCents;
  if (variant !== null) payload.variants = { [variant.title]: variant.name };
  // The "accutrak" and "printful" keys of the ping: a SKU-enabled product names the SKU, else the product (`pid_` + its external id).
  if (LinkFlags.isSet(link.flags, "skus_enabled")) {
    payload.sku_id = variant?.sku ? (variant.sku.custom ?? variant.sku.id) : `pid_${encrypt(link.id)}`;
    if (variant?.sku?.custom != null) payload.original_sku_id = variant.sku.id;
  }
  if (offerCode !== null) payload.offer_code = offerCode.code;
  if (purchaser !== null && String(purchaser.id) === String(seller.id)) payload.test = true;
  // Purchase#is_recurring_subscription_charge: a subscription's purchase that is not its original (a gifted membership is refused above)
  if (subscription !== null && !flags("is_original_subscription_purchase")) payload.is_recurring_charge = true;
  if (flags("is_preorder_authorization")) payload.is_preorder_authorization = true;
  for (const field of customFields) payload[field.name] = field.value;
  const payloadFields = customFields.length > 0 ? customFields : subscriptionCustomFields;
  if (payloadFields.length > 0)
    payload.custom_fields = Object.fromEntries(payloadFields.map((field) => [field.name, field.value]));
  if (licenseKey !== null) {
    payload.license_key = licenseKey;
    payload.is_multiseat_license = flags("is_multiseat_license");
  }
  if (present(purchase.ip_country)) payload.ip_country = purchase.ip_country;
  if (subscription !== null) payload.recurrence = await subscriptionRecurrence(subscription);
  if (affiliate.named) payload.affiliate = affiliate.email;
  payload.is_gift_receiver_purchase = giftReceiver;
  if (gift !== null) {
    payload.gift_price = gift.price;
    payload.gifter_email = gift.gifterEmail;
  }
  payload.refunded = stripeRefunded === true;
  payload.disputed = chargedBack;
  payload.dispute_won = reversed;

  // purchase_as_json: the whitelisted keys of `as_json_for_license` (version 1, so `variants` is a string and `custom_fields` a list).
  const asJson: Record<string, unknown> = {
    id: encrypt(purchase.id),
    created_at: timeJson(purchase.created_at),
    variants: variant === null || variant.hidden === true ? "" : variantsDisplayable(variant.name),
    custom_fields: customFields.map((field) => `${field.name}: ${field.value ?? ""}`),
  };
  if (offerCode !== null) asJson.offer_code = offerCode;
  if (recurringBilling) {
    // `refunded` is the raw column here, which `delete_if nil` drops.
    if (stripeRefunded !== null) asJson.refunded = stripeRefunded;
    asJson.subscription_ended_at = timeJson(subscription!.ended_at);
    asJson.subscription_cancelled_at = timeJson(subscription!.cancelled_at);
    asJson.subscription_failed_at = timeJson(subscription!.failed_at);
  } else {
    asJson.refunded = stripeRefunded === true;
    asJson.chargebacked = chargedBack && !reversed;
  }
  return { ...payload, ...asJson };
}
