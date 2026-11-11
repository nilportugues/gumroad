// What a URL puts on the checkout page: CheckoutPresenter#checkout_arrival_props (`?product=`, `?wishlist=`,
// `?gift_wishlist_product=` and the `accepted_offer_id` of an upsell), Checkout::StripePaymentPresenter#props over those
// products and CheckoutController#sole_seller_checkout_style.
//
// Only the page's own cart is empty here (the filter hands back one with lines or stored codes), so the payment
// configuration and the theme depend on the arrival alone.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { decrypt, encrypt, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { fetchLeniently } from "../../controllers/product-page.ts";
import { queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { geoIpLookup } from "../../infra/geo-ip.ts";
import { alpha2ByName } from "../../models/compliance-countries.ts";
import { contrastFor, visibleIndicator } from "../../models/contrast-color.ts";
import { dangerColor, fontFamily, withDefaults, customStyles } from "../../models/seller-profile-styles.ts";
import { BORDER_RADIUS_CSS } from "../../models/seller-profile.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { RISK_STATES, sellerProfile as loadSellerProfile, UserFlags, Users } from "../../models/user.ts";
import { checkoutProduct, type CartParams, type CheckoutParams } from "../../presenters/checkout-product.ts";
import { findLink, findUserById, type LinkRow, type UserRow } from "../../presenters/product-reads.ts";
import { NotPortedError } from "../not-ported.ts";

import DATA from "./checkout-data.generated.json" with { type: "json" };

// RecommendationType::WISHLIST_RECOMMENDATION
const WISHLIST_RECOMMENDATION = "wishlist";
// Checkout::StripePaymentPresenter
const STRIPE_PAYMENT_ELEMENT_CHECKOUT = "stripe_payment_element_checkout";
const STRIPE_PAYMENT_ELEMENT_CLIENT_CONFIRM = "stripe_payment_element_client_confirm";
const APPLE_PAY_MERCHANT_TOKENS = "apple_pay_merchant_tokens";
const PAYMENT_ELEMENT_WALLETS = "payment_element_wallets";
const INDIA_CARD_MANDATE_RELIABILITY = "india_card_mandate_reliability";
const STRIPE_PAYMENT_ELEMENT_MINIMUM_USD_CHARGE_CENTS = 50;
const INDIA_ALPHA2 = "IN";

// The params CheckoutController#checkout_params permits; a flat query gives a String, nil (a key without "=") or nothing.
export const CHECKOUT_PARAM_NAMES = [
  "username",
  "product",
  "wishlist",
  "gift_wishlist_product",
  "accepted_offer_id",
  "affiliate_id",
  "recommended_by",
  "recommender_model_name",
  "option",
  "rent",
  "recurrence",
  "pay_in_installments",
  "price",
  "quantity",
  "call_start_time",
  "force_new_subscription",
] as const;
export type RequestParams = Partial<Record<(typeof CHECKOUT_PARAM_NAMES)[number], string | null>>;

// params.permit(...) of a flat query: Rack's last occurrence wins and a key without "=" is nil.
export function requestParamsOf(queryString: string): RequestParams {
  const request = { queryString } as RailsRequest;
  const params: RequestParams = {};
  for (const name of CHECKOUT_PARAM_NAMES) {
    const value = queryParam(request, name);
    if (value !== undefined) params[name] = value;
  }
  return params;
}

// The params that put a product on the page.
export const hasArrivalParams = (params: RequestParams) =>
  params.product !== undefined || params.wishlist !== undefined || params.gift_wishlist_product !== undefined;

export type CheckoutProductProps = Awaited<ReturnType<typeof checkoutProduct>>;
export type Arrival = {
  clear_cart: boolean;
  add_products: CheckoutProductProps[];
  gift?: { type: string; id: string | null; name: string | null; note: string; hideGifter: boolean };
};

// String#to_i
function rubyToI(value: string): number {
  const match = /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
  const parsed = match ? Number(match[0].replaceAll("_", "")) : 0;
  if (!Number.isSafeInteger(parsed)) throw new NotPortedError("an integer beyond 2^53");
  return parsed;
}

const given = (value: string | null | undefined): boolean => value !== undefined && value !== null;
const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);

// The args Link#cart_item(params) reads from the request: `!!params[:rent]` is true for any value, an empty one included.
function cartParamsOf(params: RequestParams): CartParams {
  return {
    option: params.option ?? null,
    recurrence: params.recurrence ?? null,
    price: rubyToI(params.price ?? ""),
    rent: given(params.rent),
    quantity: present(params.quantity) ? rubyToI(params.quantity) : null,
    callStartTime: params.call_start_time ?? null,
    payInInstallments: given(params.pay_in_installments),
    forceNewSubscription: given(params.force_new_subscription),
  };
}

const checkoutParamsOf = (params: RequestParams): CheckoutParams => ({
  affiliateId: params.affiliate_id ?? null,
  recommendedBy: params.recommended_by ?? null,
  recommenderModelName: params.recommender_model_name ?? null,
  acceptedOfferId: params.accepted_offer_id ?? null,
});

async function userByUsername(username: string | null | undefined): Promise<UserRow | null> {
  if (!given(username)) return null;
  const [row] = await selectRows<UserRow>(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "username")} = ${username} LIMIT 1`,
  );
  return row ?? null;
}

// Link.find_by_unique_permalink, which does not skip deleted products.
async function findByUniquePermalink(permalink: string): Promise<LinkRow | null> {
  const [row] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

type Context = { buyerId: bigint | null; ip: string | null };

async function product(row: LinkRow, context: Context, cartParams: CartParams, params: CheckoutParams) {
  const seller = row.user_id === null ? null : await findUserById(row.user_id);
  if (seller === null) throw new NotPortedError("a product without a seller");
  // User#username answers the external id when the column is empty; the port reads the column.
  if (!present(seller.username)) throw new NotPortedError("a seller without a username");
  return checkoutProduct(row, { cartParams, arrival: true, ...context, params });
}

// CheckoutPresenter#add_single_product_props
async function singleProductProps(params: RequestParams, context: Context): Promise<CheckoutProductProps[]> {
  if (!given(params.product)) return [];
  const user = await userByUsername(params.username);
  const row = user ? await fetchLeniently(params.product!, user.id) : await findByUniquePermalink(params.product!);
  if (row === null) return [];
  return [await product(row, context, cartParamsOf(params), checkoutParamsOf(params))];
}

type WishlistProductRow = {
  id: bigint;
  wishlist_id: bigint;
  product_id: bigint;
  variant_id: bigint | null;
  recurrence: string | null;
  quantity: number;
  rent: boolean | number;
};

// `wishlist.user.global_affiliate&.external_id_numeric&.to_s`
async function globalAffiliateId(userId: bigint): Promise<string | null> {
  const [affiliate] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'GlobalAffiliate' AND ${column("affiliates", "affiliate_user_id")} = ${userId} AND ${column("affiliates", "deleted_at")} IS NULL ORDER BY ${column("affiliates", "id")} ASC LIMIT 1`,
  );
  return affiliate ? String(encryptNumeric(Number(affiliate.id))) : null;
}

// CheckoutPresenter#checkout_wishlist_product: the product as the wishlist row names it, with the request params under the defaults.
async function wishlistProduct(
  row: WishlistProductRow,
  context: Context,
  params: RequestParams,
  defaults: CheckoutParams,
) {
  const link = await findLink(row.product_id);
  if (link === null) throw new NotPortedError("a wishlist product whose product is missing");
  const cartParams: CartParams = {
    option: row.variant_id === null ? null : encrypt(row.variant_id),
    rent: Boolean(Number(row.rent)),
    recurrence: row.recurrence,
    quantity: row.quantity,
  };
  // `params.reverse_merge(...)`: a key the request carries, even without a value, wins over the default.
  const merged: CheckoutParams = {
    affiliateId: params.affiliate_id !== undefined ? (params.affiliate_id ?? null) : (defaults.affiliateId ?? null),
    recommendedBy:
      params.recommended_by !== undefined ? (params.recommended_by ?? null) : (defaults.recommendedBy ?? null),
    recommenderModelName: params.recommender_model_name ?? null,
    acceptedOfferId: params.accepted_offer_id ?? null,
  };
  return product(link, context, cartParams, merged);
}

// CheckoutPresenter#checkout_wishlist_props: `alive_wishlist_products.available_to_buy`, a live product of an account that is not
// suspended. The relation has no ORDER BY; with the wishlist as the filtered table the rows come in id order.
async function wishlistProps(params: RequestParams, context: Context): Promise<CheckoutProductProps[] | null> {
  if (!present(params.wishlist)) return null;
  const id = decrypt(params.wishlist);
  if (id === null) return null;
  const [wishlist] = await selectRows<{ id: bigint; user_id: bigint }>(
    Prisma.sql`SELECT ${column("wishlists", "id")}, ${column("wishlists", "user_id")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${BigInt(id)} AND ${column("wishlists", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (wishlist === undefined) return null;
  const rows = await selectRows<WishlistProductRow>(
    Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table("wishlist_products")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("wishlist_products", "product_id")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("links", "user_id")} WHERE ${column("wishlist_products", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_products", "deleted_at")} IS NULL AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("users", "user_risk_state")} NOT IN (${Prisma.join([...RISK_STATES.SUSPENDED])}) ORDER BY ${column("wishlist_products", "id")} ASC`,
  );
  const affiliateId = await globalAffiliateId(wishlist.user_id);
  const defaults: CheckoutParams = { affiliateId, recommendedBy: WISHLIST_RECOMMENDATION };
  const products: CheckoutProductProps[] = [];
  for (const row of rows) products.push(await wishlistProduct(row, context, params, defaults));
  return products;
}

// CheckoutPresenter#checkout_wishlist_gift_props
async function giftProps(
  params: RequestParams,
  context: Context,
): Promise<Pick<Arrival, "add_products" | "gift"> | null> {
  if (!present(params.gift_wishlist_product)) return null;
  const id = decrypt(params.gift_wishlist_product);
  if (id === null) return null;
  const [row] = await selectRows<WishlistProductRow>(
    Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "id")} = ${BigInt(id)} AND ${column("wishlist_products", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (row === undefined) return null;
  const [wishlist] = await selectRows<{ user_id: bigint }>(
    Prisma.sql`SELECT ${column("wishlists", "user_id")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${row.wishlist_id} LIMIT 1`,
  );
  if (wishlist === undefined) throw new NotPortedError("a wishlist product without its wishlist");
  // `wishlist_product unless wishlist_product&.wishlist&.user == logged_in_user`
  if (context.buyerId !== null && BigInt(wishlist.user_id) === context.buyerId) return null;
  const owner = await findUserById(wishlist.user_id);
  if (owner === null) throw new NotPortedError("a wishlist without its owner");
  return {
    add_products: [
      await wishlistProduct(row, context, params, { affiliateId: null, recommendedBy: WISHLIST_RECOMMENDATION }),
    ],
    gift: {
      type: "anonymous",
      id: owner.external_id,
      // User#name_or_username
      name: present(owner.name) ? owner.name : owner.username,
      note: "",
      hideGifter: false,
    },
  };
}

// CheckoutPresenter#checkout_arrival_props
export async function checkoutArrival(params: RequestParams, user: User | null, ip: string | null): Promise<Arrival> {
  const context: Context = { buyerId: user === null ? null : BigInt(user.id), ip };
  const arrival: Arrival = { clear_cart: false, add_products: await singleProductProps(params, context) };
  const wishlist = await wishlistProps(params, context);
  if (wishlist !== null) arrival.add_products = wishlist;
  const gift = await giftProps(params, context);
  if (gift !== null) {
    arrival.clear_cart = true;
    arrival.add_products = gift.add_products;
    arrival.gift = gift.gift;
  }
  return arrival;
}

type PaymentItem = {
  seller: UserRow | null;
  price: number;
  quantity: number | null;
  recurrence: string | null;
  payInInstallments: boolean;
  isPreorder: boolean;
  hasFreeTrial: boolean;
  hasCustomizablePrice: boolean;
  pppDiscounted: boolean;
};

// StripePaymentPresenter#buyer_can_name_price?
function buyerCanNamePrice(added: CheckoutProductProps): boolean {
  const info = added.product;
  if (!info.is_tiered_membership) return info.pwyw !== null;
  if (added.option_id === null) return false;
  const selected = info.options.find((option) => option.id === added.option_id);
  return selected !== undefined && Boolean(selected.is_pwyw);
}

async function everySeller(sellers: UserRow[], feature: string): Promise<boolean> {
  for (const seller of sellers) if (!(await isFeatureEnabled(feature, userActor(seller.id)))) return false;
  return true;
}

// Checkout::StripePaymentPresenter#props for a cart that holds nothing but these products. The lanes that need
// Checkout::PaymentMethodResolver (client-confirm, which the seller must be ramped into) are not ported.
export async function paymentProps(arrival: Arrival, ip: string | null) {
  const items: PaymentItem[] = [];
  for (const added of arrival.add_products) {
    const creatorId = added.product.creator?.id;
    const seller = creatorId ? await userByExternalId(creatorId) : null;
    items.push({
      seller,
      price: added.price,
      quantity: added.quantity,
      recurrence: added.recurrence,
      payInInstallments: added.pay_in_installments,
      isPreorder: added.product.is_preorder,
      hasFreeTrial: added.product.free_trial !== null,
      hasCustomizablePrice: buyerCanNamePrice(added),
      pppDiscounted: added.product.ppp_details !== null,
    });
  }
  const sellers = [...new Map(items.map((item) => [item.seller?.id ?? null, item.seller])).values()];
  const known = sellers.filter((seller): seller is UserRow => seller !== null);
  const linkDisabled =
    known.length === sellers.length &&
    sellers.length > 0 &&
    known.every((seller) => UserFlags.isSet(seller.flags, "link_disabled"));
  const buyerCountry = alpha2ByName(geoIpLookup(ip)?.countryName ?? null);

  const cardElement = async (fallbackReason: string) => ({
    integration: "card_element",
    fallback_reason: fallbackReason,
    // Nothing the port renders is a buyer-currency presentment candidate: those displays hand back.
    disable_wallets: false,
    request_apple_pay_merchant_tokens:
      sellers.length > 0 && known.length === sellers.length && (await everySeller(known, APPLE_PAY_MERCHANT_TOKENS)),
    india_card_mandate_reliability: await indiaCardMandateReliability(items, known),
    payment_element_wallets: false,
    flat_payment_methods: false,
    stripe_link_enabled: !linkDisabled,
    elements_options: null,
  });

  if (items.length === 0) return cardElement("empty_cart");
  if (known.length !== sellers.length) return cardElement("unknown_seller");
  if (!(await everySeller(known, STRIPE_PAYMENT_ELEMENT_CHECKOUT)))
    return items.length === 1 && buyerCountry === INDIA_ALPHA2
      ? notPorted("the recurring UPI registration shape")
      : cardElement("stripe_payment_element_flag_disabled");

  const total = items.reduce((sum, item) => sum + item.price, 0);
  const futureCharge = (item: PaymentItem) => item.isPreorder || item.hasFreeTrial;
  const setupWithoutCharging = items.every(futureCharge) && total > 0;
  if (!(sellers.length === 1 && setupWithoutCharging)) {
    if (items.some(futureCharge)) return cardElement("setup_or_installment_flow");
    if (total <= 0 && !items.some((item) => item.hasCustomizablePrice)) return cardElement("not_charged");
    if (total > 0 && total < STRIPE_PAYMENT_ELEMENT_MINIMUM_USD_CHARGE_CENTS)
      return cardElement("stripe_payment_element_amount_below_minimum");
  }

  const priceStillPending = total <= 0 && items.some((item) => item.hasCustomizablePrice);
  if (!setupWithoutCharging && !priceStillPending && (await everySeller(known, STRIPE_PAYMENT_ELEMENT_CLIENT_CONFIRM)))
    return notPorted("Checkout::PaymentMethodResolver for a seller on the client-confirm Payment Element");

  const wallets = await everySeller(known, PAYMENT_ELEMENT_WALLETS);
  const pppVerification = items.some(
    (item) =>
      item.pppDiscounted &&
      !UserFlags.isSet(item.seller!.flags, "purchasing_power_parity_payment_verification_disabled"),
  );
  return {
    integration: "payment_element",
    fallback_reason: null,
    disable_wallets: false,
    request_apple_pay_merchant_tokens: await everySeller(known, APPLE_PAY_MERCHANT_TOKENS),
    india_card_mandate_reliability: await indiaCardMandateReliability(items, known),
    payment_element_wallets: wallets,
    flat_payment_methods: wallets,
    elements_options: {
      stripe_elements_mode: setupWithoutCharging ? "setup" : "payment",
      currency: "usd",
      buyer_currency_presentment: false,
      payment_method_types: ["card"],
      inr_local_methods: [],
      payment_method_creation: "manual",
      stripe_link_enabled: !linkDisabled && !pppVerification,
    },
  };
}

function notPorted(what: string): never {
  throw new NotPortedError(what);
}

// StripePaymentPresenter#india_card_mandate_reliability?: off unless the seller is ramped into the flag, whose answer reads their merchant account.
async function indiaCardMandateReliability(items: PaymentItem[], sellers: UserRow[]): Promise<boolean> {
  if (items.length !== 1 || sellers.length !== 1) return false;
  if (!(await isFeatureEnabled(INDIA_CARD_MANDATE_RELIABILITY, userActor(sellers[0]!.id)))) return false;
  return notPorted("StripeIntentChargeRouting.direct_charge_account? for a seller on india_card_mandate_reliability");
}

async function userByExternalId(externalId: string): Promise<UserRow | null> {
  const [row] = await selectRows<UserRow>(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${externalId} LIMIT 1`,
  );
  return row ?? null;
}

// CheckoutController#sole_seller_checkout_style over a cart that holds nothing: the arriving products' one seller, when its
// storefront theme compiles.
export async function checkoutStyle(arrival: Arrival) {
  const permalinks = arrival.add_products.map((added) => added.product.permalink);
  const sellerIds = new Map<string, bigint>();
  if (permalinks.length > 0) {
    const rows = await selectRows<{ unique_permalink: string; user_id: bigint }>(
      Prisma.sql`SELECT ${column("links", "unique_permalink")}, ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} IN (${Prisma.join(permalinks)})`,
    );
    for (const row of rows) sellerIds.set(row.unique_permalink, row.user_id);
  }
  const arriving = arrival.add_products.flatMap((added) => {
    const sellerId = sellerIds.get(added.product.permalink!);
    return sellerId === undefined ? [] : [sellerId];
  });
  const products = arriving.length > DATA.maxAllowedCartProducts ? [] : arriving;
  const unique = [...new Set(products.map(String))];
  if (unique.length !== 1) return null;

  const seller = await findUserById(BigInt(unique[0]!));
  if (seller === null) return null;
  const profile = await loadSellerProfile(Users.load(seller as unknown as User));
  const attributes = withDefaults({
    font: profile.get("font"),
    background_color: profile.get("background_color"),
    highlight_color: profile.get("highlight_color"),
    border_radius: profile.get("border_radius"),
    button_hover: profile.get("button_hover"),
  });
  const css = customStyles(attributes);
  if (css === "") return null;
  return {
    css,
    seller_id: seller.external_id,
    theme: {
      accent_color: attributes.highlight_color,
      indicator_color: visibleIndicator(attributes.highlight_color, attributes.background_color),
      background_color: attributes.background_color,
      text_color: contrastFor(attributes.background_color),
      danger_color: dangerColor(attributes.background_color!),
      font_family: fontFamily(attributes.font!),
      border_radius: BORDER_RADIUS_CSS[attributes.border_radius!],
    },
  };
}
