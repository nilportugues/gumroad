// CheckoutController#show for a cart that holds nothing and a URL that adds nothing: CartPresenter#cart_props,
// CheckoutPresenter#checkout_props and #checkout_payment_props, CheckoutRecaptcha and TipOptionsService.
//
// Everything that needs a product (a cart line, `product=`, a wishlist, a stored discount code) is handed back to
// Rails by `planCheckout`: `CheckoutPresenter#checkout_product`, `OfferCodeDiscountComputingService` and
// `Checkout::StripePaymentPresenter`'s lane selection over products are not ported.
import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { getConfig } from "../../infra/config.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { geoIpLookup } from "../../infra/geo-ip.ts";
import { getRedis } from "../../infra/redis.ts";
import { LinkFlags } from "../../models/link.ts";
import { alpha2ByName } from "../../models/compliance-countries.ts";
import { selectRows } from "../../models/sql.ts";
import type { Arrival } from "./arrivals.ts";
import DATA from "./checkout-data.generated.json" with { type: "json" };

const MONEY_SITE_KEY = "RECAPTCHA_MONEY_SITE_KEY";
const SCORE_SITE_KEY = "RECAPTCHA_MONEY_SCORE_SITE_KEY";
const PAYPAL_CLIENT_ID = "PAYPAL_PARTNER_CLIENT_ID";
const TIP_OPTIONS_KEY = "tip_options";
const DEFAULT_TIP_OPTION_KEY = "default_tip_option";
const UPI_PAYMENT_METHOD_TYPE = "upi";
const PAYPAL_CARD_TYPE = "paypal";
const UPI_CARD_TYPE = "upi";
const INDIA_ALPHA2 = "IN";

export type CartRow = {
  id: bigint;
  email: string | null;
  return_url: string | null;
  reject_ppp_discount: number | boolean;
  discount_codes: unknown;
  browser_guid: string | null;
  user_id: bigint | null;
};

const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);

// Cart.fetch_by: the user's first alive cart, else (for a visitor with a guid) the alive guest cart of that browser.
export async function fetchCart(userId: bigint | null, browserGuid: string | null): Promise<CartRow | null> {
  const columns = Prisma.raw("`carts`.`id`, `carts`.`email`, `carts`.`return_url`, `carts`.`reject_ppp_discount`, `carts`.`discount_codes`, `carts`.`browser_guid`, `carts`.`user_id`");
  if (userId !== null) {
    const [row] = await selectRows<CartRow>(Prisma.sql`SELECT ${columns} FROM \`carts\` WHERE \`carts\`.\`deleted_at\` IS NULL AND \`carts\`.\`user_id\` = ${userId} ORDER BY \`carts\`.\`id\` ASC LIMIT 1`);
    return row ?? null;
  }
  if (!present(browserGuid) && (browserGuid ?? "") === "") return null;
  const [row] = await selectRows<CartRow>(
    Prisma.sql`SELECT ${columns} FROM \`carts\` WHERE \`carts\`.\`deleted_at\` IS NULL AND \`carts\`.\`browser_guid\` = ${browserGuid} AND \`carts\`.\`user_id\` IS NULL LIMIT 1`,
  );
  return row ?? null;
}

// `Cart.fetch_by(user:, browser_guid:)&.cart_products&.alive&.count || 0`, as LinksController#cart_items_count counts it.
export async function aliveCartProductCount(userId: bigint | null, browserGuid: string | null): Promise<number> {
  const cart = await fetchCart(userId, browserGuid);
  if (cart === null) return 0;
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM \`cart_products\` WHERE \`cart_products\`.\`cart_id\` = ${cart.id} AND \`cart_products\`.\`deleted_at\` IS NULL`,
  );
  return Number(row?.count ?? 0);
}

// Cart#visible_cart_products: alive lines whose product is not archived.
export async function visibleCartProductCount(cartId: bigint): Promise<number> {
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM \`cart_products\` INNER JOIN \`links\` ON \`links\`.\`id\` = \`cart_products\`.\`product_id\` WHERE \`cart_products\`.\`cart_id\` = ${cartId} AND \`cart_products\`.\`deleted_at\` IS NULL AND ${LinkFlags.condition("archived", false)}`,
  );
  return Number(row?.count ?? 0);
}

// A stored `discount_codes` of a cart: JSON, [] when unset.
export function storedDiscountCodeCount(cart: CartRow): number {
  const codes = typeof cart.discount_codes === "string" ? (JSON.parse(cart.discount_codes) as unknown) : cart.discount_codes;
  return Array.isArray(codes) ? codes.length : codes == null ? 0 : 1;
}

export type CheckoutCart = { email: string | null; returnUrl: string; rejectPppDiscount: boolean };

// CartPresenter#cart_props with no visible line and no stored code.
export function cartProps(cart: CheckoutCart | null) {
  if (cart === null) return null;
  return { email: cart.email, returnUrl: cart.returnUrl, rejectPppDiscount: cart.rejectPppDiscount, discountCodes: [], items: [] };
}

export function cartStateOf(cart: CartRow): CheckoutCart {
  return { email: present(cart.email) ? cart.email : null, returnUrl: present(cart.return_url) ? cart.return_url : "", rejectPppDiscount: Boolean(Number(cart.reject_ppp_discount)) };
}

// TipOptionsService.get_tip_options / get_default_tip_option: unparsable or non-integer Redis values fall back.
const isIntegerArray = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => Number.isInteger(item));

export async function tipOptions(): Promise<number[]> {
  try {
    const stored = await getRedis("main").get(TIP_OPTIONS_KEY);
    const parsed: unknown = stored === null ? DATA.defaultTipOptions : JSON.parse(stored);
    return isIntegerArray(parsed) ? parsed : DATA.defaultTipOptions;
  } catch {
    return DATA.defaultTipOptions;
  }
}

export async function defaultTipOption(): Promise<number> {
  const stored = await getRedis("main").get(DEFAULT_TIP_OPTION_KEY);
  // String#to_i: leading digits, else 0; always an Integer, so the validity check passes.
  return stored === null ? DATA.defaultDefaultTipOption : parseRubyInteger(stored);
}

function parseRubyInteger(text: string): number {
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(text);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

// CheckoutRecaptcha.score_based? / site_key
async function recaptcha(user: User | null) {
  const scoreKey = getConfig(SCORE_SITE_KEY);
  const challengeKey = getConfig(MONEY_SITE_KEY) ?? null;
  const scoreBased = present(scoreKey) && (await isFeatureEnabled(DATA.recaptchaCohortFeature, user ? userActor(user.id) : null));
  return { key: scoreBased ? scoreKey! : challengeKey, scoreBased, challengeKey };
}

type CreditCardRow = { card_type: string | null; visual: string | null; expiry_month: number | null; expiry_year: number | null; card_country: string | null; payment_method_type: string | null };

// CheckoutPresenter.saved_card
async function savedCard(user: User | null) {
  if (!user?.credit_card_id) return null;
  const card = await db.creditCard.findUnique({
    where: { id: Number(user.credit_card_id) },
    select: { card_type: true, visual: true, expiry_month: true, expiry_year: true, card_country: true, payment_method_type: true },
  });
  if (!card || card.card_type === PAYPAL_CARD_TYPE) return null;
  return savedCardProps(card);
}

export function savedCardProps(card: CreditCardRow) {
  const upi = card.payment_method_type === UPI_PAYMENT_METHOD_TYPE || card.card_type === UPI_CARD_TYPE;
  return {
    type: card.card_type,
    number: card.visual,
    // CreditCard#expiry_visual
    expiration_date: card.expiry_month == null || card.expiry_year == null ? null : `${String(card.expiry_month).padStart(2, "0")}/${String(card.expiry_year).slice(-2)}`,
    requires_mandate: !upi && card.card_country === INDIA_ALPHA2,
  };
}

// CheckoutPresenter#checkout_props. `remoteIp` is request.remote_ip.
export async function checkoutProps({
  user,
  remoteIp,
  protocol,
  discoverDomain,
  arrival = { clear_cart: false, add_products: [] },
}: {
  user: User | null;
  remoteIp: string | null;
  protocol: string;
  discoverDomain: string;
  arrival?: Arrival;
}) {
  const geo = geoIpLookup(remoteIp);
  const detectedCountry = geo?.countryName ?? null;
  const country = user?.country ?? detectedCountry;
  const detectedState = detectedCountry !== null && (detectedCountry === DATA.usaCommonName || detectedCountry === DATA.canCommonName) ? (geo?.regionName ?? null) : null;
  const captcha = await recaptcha(user);

  return {
    discover_url: `${protocol}://${discoverDomain}/discover`,
    countries: DATA.countries,
    us_states: DATA.usStates,
    ca_provinces: DATA.caProvinces,
    // checkout_common puts the challenge key first; the cohort-aware key replaces its value in place.
    recaptcha_key: captcha.key,
    paypal_client_id: getConfig(PAYPAL_CLIENT_ID) ?? null,
    recaptcha_score_based: captcha.scoreBased,
    recaptcha_challenge_key: captcha.challengeKey,
    country: country === null ? null : alpha2ByName(country),
    state: user?.state ?? detectedState,
    address: user ? { street: user.street_address, zip: user.zip_code, city: user.city } : null,
    saved_credit_card: await savedCard(user),
    gift: arrival.gift ?? null,
    clear_cart: arrival.clear_cart,
    add_products: arrival.add_products,
    max_allowed_cart_products: DATA.maxAllowedCartProducts,
    cart_save_debounce_ms: DATA.cartSaveDebounceMs,
    tip_options: await tipOptions(),
    default_tip_option: await defaultTipOption(),
  };
}

// Checkout::StripePaymentPresenter#props for an empty cart: `fallback_reason_for` answers "empty_cart" before any
// flag or seller is read, and no seller means every seller-complete check is false.
export function emptyCartPaymentProps() {
  return {
    integration: "card_element",
    fallback_reason: "empty_cart",
    disable_wallets: false,
    request_apple_pay_merchant_tokens: false,
    india_card_mandate_reliability: false,
    payment_element_wallets: false,
    flat_payment_methods: false,
    stripe_link_enabled: true,
    elements_options: null,
  };
}
