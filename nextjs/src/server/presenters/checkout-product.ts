// CheckoutPresenter#checkout_product (app/presenters/checkout_presenter.rb) and Link#cart_item for the two callers that have no
// buyer: Checkout::FormPresenter#form_props and Checkout::UpsellsController#cart_item (`logged_in_user: nil, ip: nil`, empty params).
//
// What Rails derives from the Stripe/PayPal lanes, a signed URL, a random token or a variant of the product this port does not read
// throws NotPortedError, so the caller hands the request back before anything is sent: PPP, a thumbnail or avatar variant Rails has not
// processed yet, custom fields linked against their ids, and a seller on buyer-local currency.
import { Prisma, type User } from "@prisma/client";

import { decrypt, encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { autoLink } from "../html/rinku.ts";
import { sanitize } from "../html/sanitizer.ts";
import { CONTINENT_SHIPPING_COUNTRIES } from "../infra/continent-shipping-countries.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { alpha2ByName, COUNTRIES, isBlockedCountry } from "../models/compliance-countries.ts";
import { isAdult } from "../models/concerns/adult-keyword-detector.ts";
import { getRate, rubyStringToF, isCurrencyTypeSingleUnit } from "../models/concerns/currency-helper.ts";
import { CustomFieldFlags } from "../models/custom-field.ts";
import { LinkFlags } from "../models/link.ts";
import { currencyMinPrice } from "../models/purchase-pricing.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { discountForDisplay } from "../models/upsell.ts";
import { aliveUserComplianceInfoRow } from "../models/user-compliance-info.ts";
import { UserFlags } from "../models/user.ts";
import { thumbnailUrl } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { issueRestartIntentToken } from "../services/checkout-restart-intent-token.ts";

import {
  aliveBundleProducts,
  analyticsData,
  BASE_VARIANT_CLOSED_FLAG,
  linkOptions,
  linkRecurrences,
  listedPriceCents,
  pppDetails,
  quantityLeft,
  RECURRENCE_MONTHS,
  remainingForSaleCount,
  rentalProps,
  reviewSummary,
  subscriptionDuration,
  TRIAL_UNITS,
  type VariantRow,
} from "./product-props.ts";
import {
  alivePrices,
  bit,
  findLink,
  findUserById,
  type LinkRow,
  type PriceRow,
  type UserRow,
} from "./product-reads.ts";
import { defaultBuyerCurrencyProps, longUrl, subdomainWithProtocol } from "./product.ts";
// PaypalMerchantAccountManager::COUNTRY_CODES_NOT_SUPPORTED_BY_PCP
const PCP_UNSUPPORTED_COUNTRY_CODES = ["DZ", "BR", "CN", "EG", "IN", "IL", "JP", "FM", "MA", "TR"];
// PaypalMerchantAccountManager::COUNTRY_CODES_WITH_GRANDFATHERED_PCP
const GRANDFATHERED_PCP_COUNTRY_CODES = ["CN"];
const NATIVE_TYPE_COFFEE = "coffee";
const RENTAL_PRICE_FLAG = 1;
const decryptId = (external: string) => BigInt(decrypt(external)!);

const flag = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(row.flags, name);
const sellerFlag = (seller: UserRow, name: Parameters<typeof UserFlags.isSet>[1]) =>
  UserFlags.isSet(seller.flags, name);
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

async function exists(sql: Prisma.Sql): Promise<boolean> {
  return (await selectRows(sql)).length > 0;
}

type FieldRow = {
  id: bigint;
  field_type: string | null;
  name: string | null;
  required: boolean | number | null;
  flags: bigint | number;
};

// Link#custom_field_descriptors: the seller's global fields, then the product's own, both without the post-purchase ones.
export async function customFieldDescriptors(row: LinkRow, seller: UserRow) {
  const select = Prisma.sql`SELECT ${column("custom_fields", "id")}, ${column("custom_fields", "field_type")}, ${column("custom_fields", "name")}, ${column("custom_fields", "required")}, ${column("custom_fields", "flags")} FROM ${table("custom_fields")}`;
  const notPostPurchase = CustomFieldFlags.condition("is_post_purchase", false);
  const global = await selectRows<FieldRow>(
    Prisma.sql`${select} WHERE ${column("custom_fields", "seller_id")} = ${seller.id} AND ${column("custom_fields", "global")} = 1 AND ${notPostPurchase} ORDER BY ${column("custom_fields", "id")} ASC`,
  );
  const own = await selectRows<FieldRow>(
    Prisma.sql`${select} INNER JOIN ${table("custom_fields_products")} ON ${column("custom_fields_products", "custom_field_id")} = ${column("custom_fields", "id")} WHERE ${column("custom_fields_products", "product_id")} = ${row.id} AND ${notPostPurchase} ORDER BY ${column("custom_fields_products", "id")} ASC`,
  );
  // `product_checkout_custom_fields` is a habtm read with no ORDER BY: MySQL answers in join-row order or in field id order, depending on
  // the plan, and the two only agree when the fields were linked in id order.
  if (own.some((field, index) => index > 0 && field.id < own[index - 1]!.id))
    throw new NotPortedError("a product whose custom fields were linked against their ids");
  return [...global, ...own].map((field) => ({
    id: externalId(field.id),
    type: field.field_type,
    name: field.name,
    required: field.required === null ? null : Boolean(field.required),
    collect_per_product: CustomFieldFlags.isSet(field.flags, "collect_per_product"),
  }));
}

// `merchant_accounts.alive.charge_processor_alive.paypal`, which is also what User#merchant_account("paypal") finds
// (a PayPal account can always accept charges).
const livePaypalAccount = (seller: UserRow) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = 'paypal' LIMIT 1`,
  );

// User#paypal_connect_enabled?
async function paypalConnectEnabled(seller: UserRow): Promise<boolean> {
  const info = await aliveUserComplianceInfoRow(seller.id);
  if (info === null) return false;
  const country = alpha2ByName(info.country) ?? "";
  if (!PCP_UNSUPPORTED_COUNTRY_CODES.includes(country)) return true;
  return GRANDFATHERED_PCP_COUNTRY_CODES.includes(country) && (await livePaypalAccount(seller));
}

// User#pay_with_paypal_enabled?
async function payWithPaypalEnabled(seller: UserRow): Promise<boolean> {
  if (sellerFlag(seller, "disable_paypal_sales")) return false;
  if (!(await paypalConnectEnabled(seller)))
    return !(await isFeatureEnabled("disable_braintree_sales", userActor(seller.id)));
  return livePaypalAccount(seller);
}

// Link#rated_as_adult?
const ratedAsAdult = (row: LinkRow, seller: UserRow) =>
  flag(row, "is_adult") ||
  sellerFlag(seller, "all_adult_products") ||
  [row.name, row.description, seller.name, seller.username, seller.bio as string | null].some((text) => isAdult(text));

// CheckoutPresenter#supports_paypal
async function supportsPaypal(row: LinkRow, seller: UserRow): Promise<"native" | "braintree" | null> {
  if (await isFeatureEnabled("disable_paypal_sales")) return null;
  if ((await isFeatureEnabled("disable_nsfw_paypal_connect_sales")) && ratedAsAdult(row, seller)) return null;
  if (await isFeatureEnabled("disable_paypal_connect_sales")) {
    if (flag(row, "is_recurring_billing") || !(await payWithPaypalEnabled(seller))) return null;
    return "braintree";
  }
  if (await livePaypalAccount(seller)) return "native";
  return (await payWithPaypalEnabled(seller)) ? "braintree" : null;
}

// Link#has_offer_codes?
async function hasOfferCodes(row: LinkRow, seller: UserRow): Promise<boolean> {
  if (!sellerFlag(seller, "display_offer_code_field")) return false;
  const productCodes = await exists(
    Prisma.sql`SELECT 1 FROM ${table("offer_codes")} INNER JOIN ${table("offer_codes_products")} ON ${column("offer_codes_products", "offer_code_id")} = ${column("offer_codes", "id")} WHERE ${column("offer_codes_products", "product_id")} = ${row.id} AND ${column("offer_codes", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (productCodes) return true;
  return exists(
    Prisma.sql`SELECT 1 FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${seller.id} AND ${column("offer_codes", "universal")} = 1 AND (${column("offer_codes", "currency_type")} = ${row.price_currency_type} OR ${column("offer_codes", "currency_type")} IS NULL) AND ${column("offer_codes", "deleted_at")} IS NULL AND NOT EXISTS (SELECT 1 FROM ${table("offer_codes_excluded_products")} WHERE ${column("offer_codes_excluded_products", "offer_code_id")} = ${column("offer_codes", "id")} AND ${column("offer_codes_excluded_products", "product_id")} = ${row.id}) LIMIT 1`,
  );
}

type CartParams = { option?: string | null; recurrence?: string | null };
type CheckoutRequest = {
  // Link#cart_item(params)
  cartParams?: CartParams;
  // `include_cross_sells:`; an offered product never carries its own
  includeCrossSells?: boolean;
  // `arrival:`: a cross-sell's offered product is one the buyer is adding right now
  arrival?: boolean;
};

type OfferRow = {
  id: bigint;
  seller_id: bigint;
  product_id: bigint;
  variant_id: bigint | null;
  offer_code_id: bigint | null;
  text: string | null;
  description: string | null;
  flags: bigint | number;
};
const REPLACE_SELECTED_PRODUCTS = 1;
const OFFER_MATCHING_VERSION = 4;
const upsellColumns = Prisma.sql`${table("upsells")}.*`;
const AUTO_LINK_ATTRS = 'target="_blank" rel="noopener"';

// Rinku.auto_link(sanitize(description).to_s, :all, 'target="_blank" rel="noopener"')
const offerDescription = (description: string | null) => autoLink(sanitize(description ?? ""), AUTO_LINK_ATTRS);

// BaseVariant#available?
async function variantAvailable(product: LinkRow, variant: VariantRow): Promise<boolean> {
  if (variant.deleted_at != null) return false;
  if (await closedToNewBuyers(product, variant)) return false;
  if (variant.max_purchase_count === null) return true;
  return quantityLeft(variant)! > 0;
}

async function findVariant(id: bigint): Promise<VariantRow | null> {
  const [variant] = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${table("base_variants")}.* FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${id} LIMIT 1`,
  );
  return variant ?? null;
}

// Link#available_upsell: the product's one upsell that is alive and not paused.
async function availableUpsell(row: LinkRow): Promise<OfferRow | null> {
  const [upsell] = await selectRows<OfferRow>(
    Prisma.sql`SELECT ${upsellColumns} FROM ${table("upsells")} WHERE ${column("upsells", "product_id")} = ${row.id} AND ${column("upsells", "cross_sell")} = 0 AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = 0 LIMIT 1`,
  );
  return upsell ?? null;
}

// Link#available_cross_sells: the seller's live cross-sells that cover every product or select this one. The association has no order.
function availableCrossSells(row: LinkRow): Promise<OfferRow[]> {
  return selectRows<OfferRow>(
    Prisma.sql`SELECT ${upsellColumns} FROM ${table("upsells")} WHERE ${column("upsells", "seller_id")} = ${row.user_id} AND ${column("upsells", "cross_sell")} = 1 AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = 0 AND (${column("upsells", "universal")} = 1 OR EXISTS (SELECT 1 FROM ${table("upsells_selected_products")} WHERE ${column("upsells_selected_products", "upsell_id")} = ${column("upsells", "id")} AND ${column("upsells_selected_products", "selected_product_id")} = ${row.id})) ORDER BY ${column("upsells", "id")} ASC`,
  );
}

// The offered variant of each option of the product, from its upsell's live upsell variants (`already_purchased?` is false without a buyer).
async function upsellOfferedVariantIds(row: LinkRow, upsell: OfferRow | null): Promise<Map<string, string>> {
  const offered = new Map<string, string>();
  if (upsell === null) return offered;
  const pairs = await selectRows<{ selected_variant_id: bigint; offered_variant_id: bigint }>(
    Prisma.sql`SELECT ${column("upsell_variants", "selected_variant_id")}, ${column("upsell_variants", "offered_variant_id")} FROM ${table("upsell_variants")} WHERE ${column("upsell_variants", "upsell_id")} = ${upsell.id} AND ${column("upsell_variants", "deleted_at")} IS NULL ORDER BY ${column("upsell_variants", "id")} ASC`,
  );
  const decided = new Set<string>();
  for (const pair of pairs) {
    const selectedId = externalId(pair.selected_variant_id);
    // `find` takes the first upsell variant of the option, whether or not its offered variant is available.
    if (decided.has(selectedId)) continue;
    decided.add(selectedId);
    const variant = await findVariant(pair.offered_variant_id);
    if (variant === null) throw new NotPortedError("UpsellVariant without an offered variant");
    if (await variantAvailable(row, variant)) offered.set(selectedId, externalId(variant.id));
  }
  return offered;
}

// Upsell#offered_variant_for: with `offer_matching_version`, the offered product's version named like the one selected, else the fixed variant.
async function offeredVariantFor(upsell: OfferRow, offered: LinkRow, selectedOptionName: string | null) {
  const fixed = upsell.variant_id === null ? null : await findVariant(upsell.variant_id);
  if (!bit(upsell.flags, OFFER_MATCHING_VERSION) || !present(selectedOptionName)) return fixed;
  const skus = flag(offered, "skus_enabled");
  const versions = skus
    ? await selectRows<VariantRow>(
        Prisma.sql`SELECT ${table("base_variants")}.* FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Sku' AND ${column("base_variants", "link_id")} = ${offered.id} AND ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "flags")} & 1) = 0 ORDER BY ${column("base_variants", "id")} ASC`,
      )
    : await selectRows<VariantRow>(
        Prisma.sql`SELECT ${table("base_variants")}.* FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "variant_category_id")} = (SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${offered.id} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC LIMIT 1) ORDER BY ${column("base_variants", "id")} ASC`,
      );
  // Mirrors Link#options: a placeholder version is shown under the product's name.
  const displayed = (version: VariantRow) => (!skus && version.name === "Untitled" ? offered.name : version.name);
  return versions.find((version) => displayed(version) === selectedOptionName) ?? fixed;
}

// BaseVariant#closed_to_new_buyers?
async function closedToNewBuyers(product: LinkRow, variant: VariantRow): Promise<boolean> {
  const closedFlag = ((Number(variant.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1;
  return (
    closedFlag &&
    variant.type === "Variant" &&
    flag(product, "is_tiered_membership") &&
    (await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(product.user_id!)))
  );
}

// `prices.is_buy.alive` of a tier, or of the product itself.
async function buyPrices(row: LinkRow, variant: VariantRow | null): Promise<PriceRow[]> {
  const prices =
    variant === null
      ? await alivePrices(row.id)
      : await selectRows<PriceRow>(
          Prisma.sql`SELECT ${table("prices")}.* FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${variant.id} AND ${column("prices", "deleted_at")} IS NULL ORDER BY ${column("prices", "id")} ASC`,
        );
  return prices.filter((price) => !bit(price.flags, RENTAL_PRICE_FLAG));
}

// Link#cart_item(params) for a buy-only product, a legacy subscription or a membership.
async function cartItem(
  row: LinkRow,
  seller: UserRow,
  options: Awaited<ReturnType<typeof linkOptions>>,
  params: CartParams,
) {
  const tiered = flag(row, "is_tiered_membership");
  let requested = options.find((o) => o.id === params.option) ?? null;
  // A closed tier reports quantity 0, but selecting it here would add a zero-quantity item.
  if (requested !== null && tiered) {
    const tier = await findVariant(decryptId(requested.id));
    if (tier !== null && (await closedToNewBuyers(row, tier))) requested = null;
  }
  const option =
    requested ?? (row.native_type !== NATIVE_TYPE_COFFEE ? (options.find((o) => o.quantity_left !== 0) ?? null) : null);
  const variant = option === null ? null : await findVariant(decryptId(option.id));
  const tier = variant !== null && variant.type === "Variant" ? variant : null;
  let recurrence: PriceRow | null = null;
  if (flag(row, "is_recurring_billing")) {
    const prices = (await buyPrices(row, tiered ? tier : null)).filter(
      (price) => RECURRENCE_MONTHS[price.recurrence ?? ""] !== undefined,
    );
    const defaultRecurrence = (await alivePrices(row.id)).find(
      (price) => price.recurrence === (subscriptionDuration(row) ?? ""),
    )?.recurrence;
    recurrence =
      prices.find((price) => price.recurrence === params.recurrence) ??
      prices.find((price) => price.recurrence === defaultRecurrence) ??
      prices.reduce<PriceRow | null>(
        (min, price) =>
          min === null || RECURRENCE_MONTHS[price.recurrence!]! < RECURRENCE_MONTHS[min.recurrence!]! ? price : min,
        null,
      );
  }
  const listed = recurrence?.price_cents ?? (await listedPriceCents(row)) ?? 0;
  // [customizable ? params[:price].to_i : 0, (recurrence&.price_cents || price_cents.to_i) + price_difference_cents].max
  let price = Math.max(0, listed + (option?.price_difference_cents ?? 0));
  if (pppEnabled(row, seller) && price !== 0 && price < currencyMinPrice(row)) price = currencyMinPrice(row);
  return { option, rental: false, recurrence: recurrence?.recurrence ?? null, price };
}

async function bundleProductProps(bundleProducts: Awaited<ReturnType<typeof aliveBundleProducts>>) {
  const props = [];
  for (const { quantity, product, variant } of bundleProducts) {
    const owner = (await findUserById(product.user_id!))!;
    props.push({
      product_id: externalId(product.id),
      name: product.name,
      native_type: product.native_type,
      thumbnail_url: await thumbnailUrl(product.id),
      url: longUrl(product, owner),
      quantity,
      variant: variant ? { id: externalId(variant.id), name: variant.name } : null,
      custom_fields: await customFieldDescriptors(product, owner),
    });
  }
  return props;
}

// The cross-sells CheckoutPresenter#checkout_product lists for a buyer who has bought nothing, which keeps every one whose product and
// offered variant can still be sold.
async function crossSellProps(row: LinkRow, selectedOptionName: string | null): Promise<Record<string, unknown>[]> {
  const props = [];
  for (const crossSell of await availableCrossSells(row)) {
    const offered = await findLink(crossSell.product_id);
    if (offered === null) throw new NotPortedError("Upsell without a product");
    const offeredVariant = await offeredVariantFor(crossSell, offered, selectedOptionName);
    const remaining = await remainingForSaleCount(offered);
    if (
      offered.deleted_at !== null ||
      (remaining !== null && remaining <= 0) ||
      (offeredVariant !== null && !(await variantAvailable(offered, offeredVariant)))
    )
      continue;
    props.push({
      id: externalId(crossSell.id),
      replace_selected_products: bit(crossSell.flags, REPLACE_SELECTED_PRODUCTS),
      text: crossSell.text ?? "",
      description: offerDescription(crossSell.description),
      offered_product: await checkoutProduct(offered, {
        cartParams: { option: offeredVariant === null ? null : externalId(offeredVariant.id) },
        includeCrossSells: false,
        arrival: true,
      }),
      discount: await discountForDisplay(crossSell, true),
      ratings: flag(offered, "display_product_reviews") ? await reviewSummary(offered) : null,
    });
  }
  return props;
}

const SYRIA = "SY";
const VIRTUAL_COUNTRY_FLAG = 1;
const ELSEWHERE = "ELSEWHERE";
const SUPPORTED_SHIPPING_COUNTRY_CODES = ["US", "CA", "GB"];
const SUPPORTED_COUNTRIES_FEATURE = "physical_shipping_us_ca_uk_only";
// Compliance::Countries.for_select, which is sorted by name.
const SELECTABLE_COUNTRY_CODES = COUNTRIES.filter(
  (country) => !isBlockedCountry(country.alpha2) && country.alpha2 !== SYRIA,
)
  .sort((a, b) => (a.common_name < b.common_name ? -1 : a.common_name > b.common_name ? 1 : 0))
  .map((country) => country.alpha2);
// ShippingDestination::Destinations.shipping_countries.keys
const SHIPPING_COUNTRY_KEYS = new Set([
  "US",
  "ASIA",
  "EUROPE",
  "NORTH AMERICA",
  ELSEWHERE,
  ...SELECTABLE_COUNTRY_CODES,
]);

// ShippingDestination#country_or_countries, keys only: a continent or ELSEWHERE stands for the countries it covers.
function countriesOfDestination(countryCode: string, virtual: boolean): string[] {
  const countries =
    virtual || countryCode === ELSEWHERE
      ? (CONTINENT_SHIPPING_COUNTRIES[countryCode] ?? SELECTABLE_COUNTRY_CODES)
      : SHIPPING_COUNTRY_KEYS.has(countryCode)
        ? [countryCode]
        : [];
  return countries.filter((code) => !isBlockedCountry(code));
}

// Link#shippable_country_codes: the union of the live destinations' countries minus the exclusions, empty for a digital product.
async function shippableCountryCodes(row: LinkRow): Promise<string[]> {
  if (!flag(row, "is_physical")) return [];
  const destinations = await selectRows<{ country_code: string; flags: bigint | number }>(
    Prisma.sql`SELECT ${column("shipping_destinations", "country_code")}, ${column("shipping_destinations", "flags")} FROM ${table("shipping_destinations")} WHERE ${column("shipping_destinations", "link_id")} = ${row.id} AND ${column("shipping_destinations", "deleted_at")} IS NULL ORDER BY ${column("shipping_destinations", "id")} ASC`,
  );
  const exclusions = new Set(
    (
      await selectRows<{ country_code: string }>(
        Prisma.sql`SELECT ${column("shipping_exclusions", "country_code")} FROM ${table("shipping_exclusions")} WHERE ${column("shipping_exclusions", "product_id")} = ${row.id}`,
      )
    ).map((exclusion) => exclusion.country_code),
  );
  const included = destinations.flatMap((destination) =>
    countriesOfDestination(destination.country_code, bit(destination.flags, VIRTUAL_COUNTRY_FLAG)),
  );
  const shippable = [...new Set(included)].filter((code) => !exclusions.has(code));
  return (await isFeatureEnabled(SUPPORTED_COUNTRIES_FEATURE))
    ? shippable.filter((code) => SUPPORTED_SHIPPING_COUNTRY_CODES.includes(code))
    : shippable;
}

// CheckoutPresenter#checkout_product with `logged_in_user: nil, ip: nil` and no params.
export async function checkoutProduct(row: LinkRow, request: CheckoutRequest = {}) {
  const { cartParams = {}, includeCrossSells = true, arrival = false } = request;
  const seller = (await findUserById(row.user_id!))!;

  const shippableCountries = await shippableCountryCodes(row);
  const upsell = await availableUpsell(row);
  const offeredVariantIds = await upsellOfferedVariantIds(row, upsell);
  const bundleProducts = await aliveBundleProducts(row.id);
  const options = await linkOptions(row);
  const item = await cartItem(row, seller, options, cartParams);
  const [creatorAvatar, thumbnail] = [
    present(seller.username) ? await avatarUrl(seller as unknown as User) : null,
    await thumbnailUrl(row.id),
  ];
  const currency = String(row.price_currency_type);
  const profileUrl = subdomainWithProtocol(seller);
  const price = await listedPriceCents(row);
  const buyerCurrencyDisplay = defaultBuyerCurrencyProps(row);
  const rate = rubyStringToF(await getRate(currency)) / (isCurrencyTypeSingleUnit(currency) ? 100 : 1);
  const tiered = flag(row, "is_tiered_membership");
  const recurring = flag(row, "is_recurring_billing");
  const preorder = flag(row, "is_in_preorder_state");
  const rental = await rentalProps(row);
  const common = {
    permalink: row.unique_permalink,
    name: row.name,
    creator: present(seller.username)
      ? {
          name: seller.name ?? seller.username,
          profile_url: profileUrl,
          avatar_url: creatorAvatar,
          id: seller.external_id,
        }
      : null,
    currency_code: currency.toLowerCase(),
    price_cents: price,
    buyer_currency_display: buyerCurrencyDisplay,
    supports_paypal: await supportsPaypal(row, seller),
    paypal_card_funding_disabled: sellerFlag(seller, "paypal_card_funding_disabled"),
    link_disabled: sellerFlag(seller, "link_disabled"),
    custom_fields: await customFieldDescriptors(row, seller),
    exchange_rate: rate,
    is_tiered_membership: tiered,
    is_legacy_subscription: !tiered && recurring,
    pwyw: row.customizable_price ? { suggested_price_cents: row.suggested_price_cents } : null,
    installment_plan: await installmentPlan(row),
    is_multiseat_license: flag(row, "is_multiseat_license") && row.native_type !== "call",
    shippable_country_codes: shippableCountries,
    ships_nowhere: flag(row, "is_physical") && shippableCountries.length === 0,
  };
  const productOptions = options.map((option) => ({
    ...option,
    upsell_offered_variant_id: offeredVariantIds.get(option.id) ?? null,
  }));
  const value = {
    product: {
      ...common,
      id: externalId(row.id),
      duration_in_months: row.duration_in_months,
      url: longUrl(row, seller),
      thumbnail_url: thumbnail,
      native_type: row.native_type,
      is_preorder: preorder,
      is_multiseat_license: common.is_multiseat_license,
      is_quantity_enabled: flag(row, "quantity_enabled"),
      quantity_remaining: await remainingForSaleCount(row),
      free_trial: flag(row, "free_trial_enabled")
        ? {
            duration: {
              unit: TRIAL_UNITS[row.free_trial_duration_unit ?? -1] ?? null,
              amount: row.free_trial_duration_amount,
            },
          }
        : null,
      cross_sells: [] as Record<string, unknown>[],
      has_offer_codes: await hasOfferCodes(row, seller),
      has_tipping_enabled: sellerFlag(seller, "tipping_enabled") && !tiered && !recurring,
      require_shipping:
        Boolean(row.require_shipping) || bundleProducts.some(({ product }) => Boolean(product.require_shipping)),
      analytics: analyticsData(seller),
      rental,
      recurrences: await linkRecurrences(row),
      can_gift: !preorder && !sellerFlag(seller, "gifting_disabled"),
      options: productOptions,
      ppp_details: await pppDetails(row, seller, null),
      upsell: upsell
        ? { id: externalId(upsell.id), text: upsell.text ?? "", description: offerDescription(upsell.description) }
        : null,
      archived: flag(row, "archived"),
      bundle_products: await bundleProductProps(bundleProducts),
    },
    price: item.price,
    option_id: item.option?.id ?? null,
    rent: item.rental,
    recurrence: item.recurrence,
    quantity: null,
    call_start_time: null,
    pay_in_installments: false,
    force_new_subscription: false,
    affiliate_id: null,
    recommended_by: null,
    recommender_model_name: null,
    accepted_offer: null,
  };
  // The callers have no buyer (`logged_in_user: nil`), so the token is a guest's.
  if (arrival && flag(row, "is_recurring_billing"))
    Object.assign(value, { restart_intent: issueRestartIntentToken(row.id, null) });
  if (includeCrossSells) {
    const selectedName = productOptions.find((option) => option.id === value.option_id)?.name ?? null;
    value.product.cross_sells = await crossSellProps(row, selectedName);
  }
  return value;
}

// Link#installment_plan
async function installmentPlan(row: LinkRow) {
  const [plan] = await selectRows<{ number_of_installments: number; recurrence: string }>(
    Prisma.sql`SELECT ${column("product_installment_plans", "number_of_installments")}, ${column("product_installment_plans", "recurrence")} FROM ${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${row.id} AND ${column("product_installment_plans", "deleted_at")} IS NULL LIMIT 1`,
  );
  return plan ? { number_of_installments: plan.number_of_installments, recurrence: plan.recurrence } : null;
}

// Link#purchasing_power_parity_enabled?
function pppEnabled(row: LinkRow, seller: UserRow): boolean {
  return !flag(row, "purchasing_power_parity_disabled") && sellerFlag(seller, "purchasing_power_parity_enabled");
}

// Checkout::UpsellsController#cart_item: a membership is added on its first tier, `alive_variants.first` (lowest id).
export async function upsellsCartItem(row: LinkRow) {
  if (!flag(row, "is_tiered_membership")) return checkoutProduct(row);
  const [tier] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "id")} ASC LIMIT 1`,
  );
  if (tier === undefined)
    throw new NotPortedError("Checkout::UpsellsController#cart_item for a membership with no tier");
  return checkoutProduct(row, { cartParams: { option: externalId(tier.id) } });
}
