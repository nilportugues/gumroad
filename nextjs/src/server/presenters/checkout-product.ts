// CheckoutPresenter#checkout_product (app/presenters/checkout_presenter.rb) and Link#cart_item for the two callers that have no
// buyer: Checkout::FormPresenter#form_props and Checkout::UpsellsController#cart_item (`logged_in_user: nil, ip: nil`, empty params).
//
// What Rails derives from the Stripe/PayPal lanes, a signed URL, a random token or a variant of the product this port does not read
// throws NotPortedError, so the caller hands the request back before anything is sent: upsells and cross-sells, bundles, physical
// products (shippable countries), memberships (tier prices, restart token), PPP, a seller with a merchant account, an uploaded
// thumbnail or avatar, and a seller on buyer-local currency.
import { Prisma, type User } from "@prisma/client";

import { encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getRate, rubyStringToF, isCurrencyTypeSingleUnit } from "../models/concerns/currency-helper.ts";
import { alpha2ByName } from "../models/compliance-countries.ts";
import { CustomFieldFlags } from "../models/custom-field.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { aliveUserComplianceInfoRow } from "../models/user-compliance-info.ts";
import { UserFlags } from "../models/user.ts";
import { thumbnailUrl } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";

import {
  analyticsData,
  linkOptions,
  linkRecurrences,
  pppDetails,
  remainingForSaleCount,
  rentalProps,
  TRIAL_UNITS,
} from "./product-props.ts";
import { listedPriceCents } from "./product-props.ts";
import { findUserById, type LinkRow, type UserRow } from "./product-reads.ts";
import { buyerCurrencyDisplayProps, longUrl, subdomainWithProtocol } from "./product.ts";

// PaypalMerchantAccountManager::COUNTRY_CODES_NOT_SUPPORTED_BY_PCP
const PCP_UNSUPPORTED_COUNTRY_CODES = ["DZ", "BR", "CN", "EG", "IN", "IL", "JP", "FM", "MA", "TR"];
const NATIVE_TYPE_COFFEE = "coffee";
const BUY_ONLY = 0;

const flag = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) =>
  LinkFlags.isSet(row.flags as bigint | number, name);
const sellerFlag = (seller: UserRow, name: Parameters<typeof UserFlags.isSet>[1]) =>
  UserFlags.isSet(seller.flags as bigint | number, name);
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
  return [...global, ...own].map((field) => ({
    id: externalId(field.id),
    type: field.field_type,
    name: field.name,
    required: field.required === null ? null : Boolean(field.required),
    collect_per_product: CustomFieldFlags.isSet(field.flags, "collect_per_product"),
  }));
}

// CheckoutPresenter#supports_paypal for a seller with no merchant account, so `native_paypal_payment_enabled?` is false and
// `pay_with_paypal_enabled?` depends on the seller alone.
async function supportsPaypal(seller: UserRow): Promise<"braintree" | null> {
  if (await isFeatureEnabled("disable_paypal_sales")) return null;
  if (await isFeatureEnabled("disable_nsfw_paypal_connect_sales"))
    throw new NotPortedError("CheckoutPresenter#supports_paypal with disable_nsfw_paypal_connect_sales on");
  if (await isFeatureEnabled("disable_paypal_connect_sales"))
    throw new NotPortedError("CheckoutPresenter#supports_paypal with disable_paypal_connect_sales on");
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} LIMIT 1`,
    )
  )
    throw new NotPortedError("CheckoutPresenter#supports_paypal for a seller with a merchant account");
  // User#pay_with_paypal_enabled?
  if (sellerFlag(seller, "disable_paypal_sales")) return null;
  const info = await aliveUserComplianceInfoRow(seller.id);
  const connectEnabled = info !== null && !PCP_UNSUPPORTED_COUNTRY_CODES.includes(alpha2ByName(info.country) ?? "");
  // With PayPal Connect on, only a connected merchant account enables PayPal, and this seller has none.
  if (connectEnabled) return null;
  return (await isFeatureEnabled("disable_braintree_sales", userActor(seller.id))) ? null : "braintree";
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

async function assertNothingOffered(row: LinkRow): Promise<void> {
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("upsells")} WHERE ${column("upsells", "product_id")} = ${row.id} AND ${column("upsells", "cross_sell")} = 0 AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = 0 LIMIT 1`,
    )
  )
    throw new NotPortedError("CheckoutPresenter#checkout_product for a product with an upsell");
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("upsells")} WHERE ${column("upsells", "seller_id")} = ${row.user_id} AND ${column("upsells", "cross_sell")} = 1 AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = 0 AND (${column("upsells", "universal")} = 1 OR EXISTS (SELECT 1 FROM ${table("upsells_selected_products")} WHERE ${column("upsells_selected_products", "upsell_id")} = ${column("upsells", "id")} AND ${column("upsells_selected_products", "selected_product_id")} = ${row.id})) LIMIT 1`,
    )
  )
    throw new NotPortedError("CheckoutPresenter#checkout_product for a product with a cross-sell");
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${row.id} AND ${column("bundle_products", "deleted_at")} IS NULL LIMIT 1`,
    )
  )
    throw new NotPortedError("CheckoutPresenter#checkout_product for a bundle");
}

// Link#cart_item(params) with empty params, for a product that is not a membership.
async function cartItem(row: LinkRow, options: Awaited<ReturnType<typeof linkOptions>>) {
  if (flag(row, "is_recurring_billing") || flag(row, "is_tiered_membership"))
    throw new NotPortedError("Link#cart_item for a membership (tier prices and recurrences)");
  const option = row.native_type !== NATIVE_TYPE_COFFEE ? (options.find((o) => o.quantity_left !== 0) ?? null) : null;
  const listed = (await listedPriceCents(row)) ?? 0;
  return {
    option,
    rental: false,
    // [customizable ? params[:price].to_i : 0, price_cents.to_i + price_difference_cents].max
    price: Math.max(0, listed + (option?.price_difference_cents ?? 0)),
  };
}

export async function checkoutProduct(row: LinkRow) {
  const seller = (await findUserById(row.user_id!))!;
  if (row.purchase_type !== BUY_ONLY && row.purchase_type !== null)
    throw new NotPortedError("Link#cart_item for a rental product");
  if (flag(row, "is_physical")) throw new NotPortedError("Link#shippable_country_codes for a physical product");
  if (await pppEnabled(row, seller)) throw new NotPortedError("Link#cart_item with purchasing power parity on");
  await assertNothingOffered(row);

  const options = await linkOptions(row);
  const item = await cartItem(row, options);
  const [creatorAvatar, thumbnail] = [
    present(seller.username) ? await avatarUrl(seller as unknown as User) : null,
    await thumbnailUrl(row.id),
  ];
  const currency = String(row.price_currency_type);
  const profileUrl = subdomainWithProtocol(seller);
  const price = await listedPriceCents(row);
  const buyerCurrencyDisplay = await buyerCurrencyDisplayProps(row, seller);
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
    supports_paypal: await supportsPaypal(seller),
    paypal_card_funding_disabled: sellerFlag(seller, "paypal_card_funding_disabled"),
    link_disabled: sellerFlag(seller, "link_disabled"),
    custom_fields: await customFieldDescriptors(row, seller),
    exchange_rate: rate,
    is_tiered_membership: tiered,
    is_legacy_subscription: !tiered && recurring,
    pwyw: row.customizable_price ? { suggested_price_cents: row.suggested_price_cents } : null,
    installment_plan: await installmentPlan(row),
    is_multiseat_license: flag(row, "is_multiseat_license") && row.native_type !== "call",
    shippable_country_codes: [] as string[],
    ships_nowhere: false,
  };
  return {
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
      cross_sells: [],
      has_offer_codes: await hasOfferCodes(row, seller),
      has_tipping_enabled: sellerFlag(seller, "tipping_enabled") && !tiered && !recurring,
      require_shipping: Boolean(row.require_shipping),
      analytics: analyticsData(seller),
      rental,
      recurrences: await linkRecurrences(row),
      can_gift: !preorder && !sellerFlag(seller, "gifting_disabled"),
      options: options.map((option) => ({ ...option, upsell_offered_variant_id: null })),
      ppp_details: await pppDetails(row, seller, null),
      upsell: null,
      archived: flag(row, "archived"),
      bundle_products: [],
    },
    price: item.price,
    option_id: item.option?.id ?? null,
    rent: item.rental,
    recurrence: null,
    quantity: null,
    call_start_time: null,
    pay_in_installments: false,
    force_new_subscription: false,
    affiliate_id: null,
    recommended_by: null,
    recommender_model_name: null,
    accepted_offer: null,
  };
}

// Link#installment_plan
async function installmentPlan(row: LinkRow) {
  const [plan] = await selectRows<{ number_of_installments: number; recurrence: string }>(
    Prisma.sql`SELECT ${column("product_installment_plans", "number_of_installments")}, ${column("product_installment_plans", "recurrence")} FROM ${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${row.id} AND ${column("product_installment_plans", "deleted_at")} IS NULL LIMIT 1`,
  );
  return plan ? { number_of_installments: plan.number_of_installments, recurrence: plan.recurrence } : null;
}

// Link#purchasing_power_parity_enabled?
async function pppEnabled(row: LinkRow, seller: UserRow): Promise<boolean> {
  return !flag(row, "purchasing_power_parity_disabled") && sellerFlag(seller, "purchasing_power_parity_enabled");
}
