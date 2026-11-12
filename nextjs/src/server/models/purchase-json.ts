// Purchase#as_json(version: 2, include_buyer_presentment: true) (app/models/purchase.rb), the sale object of the v2 API.
//
// A batch of purchases is serialized from rows read in a handful of statements (the SALES_API_PRELOADS of Api::V2::SalesController).
// What the port cannot read faithfully raises NotPortedError before anything is written, and the dispatcher hands the request to
// Rails: a gift, a preorder, an affiliate, an upsell, an offer code, a buyer presentment, tax, a SKU, a shipping charge, a refund that
// failed, a sale charged outside Gumroad's own Stripe account (transaction URL), a PayPal or Stripe Connect sale.
import { Prisma } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { domainConfig } from "../infra/domain.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { railsEnv } from "../infra/rails-env.ts";
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
  GST_APPLICABLE_COUNTRY_CODES,
  NORWAY_VAT_APPLICABLE_COUNTRY_CODES,
  taxNameFor,
} from "../mail/mailers/receipt-tax.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { alpha2ByName } from "./compliance-countries.ts";
import { usdCentsToCurrency } from "./concerns/currency-helper.ts";
import { formatJustPriceInCents, moneyFormatterFormat, symbolFor } from "./concerns/money-formatter.ts";
import { instantInTimeZoneIso8601 } from "./concerns/rails-time-zone.ts";
import { timeAgoInWords } from "./concerns/time-ago-in-words.ts";
import { LinkFlags } from "./link.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "./merchant-account.ts";
import { column, selectRows, table } from "./sql.ts";
import { SubscriptionFlags } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RUBY_REF = "Purchase#as_json";
const notPorted = (what: string) => new NotPortedError(what, RUBY_REF);
const num = (value: unknown): number => Number(value);
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const truthy = (value: unknown): boolean => value === true || value === 1 || value === 1n;
const inList = (ids: readonly unknown[]) => Prisma.join(ids as (bigint | number)[]);
// ActiveSupport::JSON::Encoding.time_precision = 0, in UTC.
export const timeJson = (time: Date | null | undefined): string | null =>
  time == null ? null : time.toISOString().replace(/\.\d{3}Z$/u, "Z");
// BasePrice::Recurrence#recurrence_long_indicator
export const RECURRENCE_LONG_INDICATOR: Record<string, string> = {
  monthly: "a month",
  quarterly: "every 3 months",
  biannually: "every 6 months",
  yearly: "a year",
  every_two_years: "every 2 years",
};
// Time#to_fs(:formatted_date_abbrev_month): "%b %-d, %Y"
const formattedDateAbbrevMonth = (time: Date): string =>
  `${MONTHS[time.getUTCMonth()]} ${time.getUTCDate()}, ${time.getUTCFullYear()}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];
// Compliance::Countries.find_by_name needs the exact name; a ChargeProcessor.charge_processor_ids member can be refunded.
const CHARGE_PROCESSOR_IDS = ["stripe", "braintree", "paypal"];
const PAYPAL_REFUND_WINDOW_MONTHS = 6;

async function rowsBy(
  tableName: string,
  columnName: string,
  ids: readonly unknown[],
  extra: Prisma.Sql = Prisma.empty,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  return selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${inList(ids)})${extra} ORDER BY ${column(tableName, "id")} ASC`,
  );
}
const byId = (rows: Row[]) => new Map(rows.map((row) => [String(row.id), row]));

// `Follower.active.where(followed_id:, email: emails).pluck(:email)`, downcased (the column's collation is case-insensitive).
export async function followingEmails(sellerId: bigint | number, emails: readonly string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${column("followers", "email")} FROM ${table("followers")} WHERE ${column("followers", "confirmed_at")} IS NOT NULL AND ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} IN (${inList(emails)})`,
  );
  return new Set(rows.map((row) => String(row.email ?? "").toLowerCase()));
}

type Loaded = {
  links: Map<string, Row>;
  sellers: Map<string, Row>;
  purchasers: Map<string, Row>;
  variants: Map<string, Row[]>;
  categories: Map<string, Row>;
  hasAliveCategories: Set<string>;
  customFields: Map<string, Row[]>;
  tips: Map<string, Row>;
  utmLinks: Map<string, Row>;
  shipments: Map<string, Row>;
  licenses: Map<string, Row>;
  reviews: Map<string, Row>;
  reviewStats: Map<string, Row>;
  subscriptions: Map<string, Row>;
  // price_for_recurrence per purchase id: the purchase's own price row, else its subscription's last payment option's
  prices: Map<string, Row>;
  tierPrices: Map<string, Row>;
  zipTaxRates: Map<string, Row>;
  merchantAccountOf: (purchase: Row) => Row | null;
  gifted: Map<string, Row>;
  gifteePurchases: Map<string, Row>;
  gifteeLicenses: Map<string, Row>;
  preorders: Map<string, Row>;
  presentments: Map<string, Row>;
  chargePresentments: Map<string, Row>;
  presentmentRefundedCents: Map<string, number>;
  // Subscription#true_original_purchase: the first original-subscription purchase, by subscription id
  trueOriginal: Map<string, bigint | number>;
  ppp: Map<string, Row>;
  refundedCents: Map<string, number>;
  abandonedCartOrders: Set<string>;
};

// Reads the association rows of `purchases` and refuses what the port does not serialize.
async function load(purchases: Row[]): Promise<Loaded> {
  const ids = purchases.map((purchase) => purchase.id);
  for (const purchase of purchases) {
    const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
    if (purchase.affiliate_id != null) throw notPorted("an affiliate");
    if (purchase.offer_code_id != null) throw notPorted("an offer code");
    if (purchase.charge_processor_id === "braintree") throw notPorted("a Braintree sale");
    if (!present(purchase.displayed_price_currency_type)) throw notPorted("a purchase with no displayed currency");
    if (flags("is_commission_deposit_purchase") || flags("is_commission_completion_purchase"))
      throw notPorted("a commission");
  }

  const merchantAccounts = byId(
    await rowsBy("merchant_accounts", "id", [
      ...new Set(purchases.map((purchase) => purchase.merchant_account_id).filter((id) => id != null)),
    ]),
  );
  const merchantAccountOf = (purchase: Row): Row | null =>
    purchase.merchant_account_id == null ? null : (merchantAccounts.get(String(purchase.merchant_account_id)) ?? null);
  for (const purchase of purchases) transactionUrlForSeller(purchase, merchantAccountOf(purchase));

  const links = byId(await rowsBy("links", "id", [...new Set(purchases.map((purchase) => purchase.link_id))]));
  const sellers = byId(await rowsBy("users", "id", [...new Set(purchases.map((purchase) => purchase.seller_id))]));
  const purchasers = byId(
    await rowsBy("users", "id", [
      ...new Set(purchases.map((purchase) => purchase.purchaser_id).filter((id) => id != null)),
    ]),
  );

  if (
    ids.length > 0 &&
    (
      await selectRows(
        Prisma.sql`SELECT 1 FROM ${table("upsell_purchases")} WHERE ${column("upsell_purchases", "purchase_id")} IN (${inList(ids)}) LIMIT 1`,
      )
    ).length > 0
  )
    throw notPorted("an upsell");
  // Refund#effective?: a failed or canceled refund counts unless its balance debits were reversed
  const refunds = (await rowsBy("refunds", "purchase_id", ids)).filter(
    (refund) =>
      !(TERMINAL_FAILURE_STATUSES.includes(refund.status) && jsonData(refund).balance_reversed_on_failure === true),
  );
  const refundedCents = new Map<string, number>();
  const presentmentRefundedCents = new Map<string, number>();
  for (const refund of refunds) {
    const key = String(refund.purchase_id);
    refundedCents.set(key, (refundedCents.get(key) ?? 0) + num(refund.amount_cents ?? 0));
    const data = jsonData(refund);
    // Refund#presentment_snapshot?
    if (present(data.presentment_currency) && num(data.presentment_amount_cents ?? 0) > 0)
      presentmentRefundedCents.set(key, (presentmentRefundedCents.get(key) ?? 0) + num(data.presentment_amount_cents));
  }
  const gifts = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`gifts`.*")} FROM ${table("gifts")} WHERE ${column("gifts", "gifter_purchase_id")} IN (${inList(ids)}) OR ${column("gifts", "giftee_purchase_id")} IN (${inList(ids)}) ORDER BY ${column("gifts", "id")} ASC`,
  );
  const gifted = new Map<string, Row>();
  for (const purchase of purchases) {
    const sender = PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase");
    const receiver = PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase");
    const gift = gifts.find(
      (candidate) =>
        String(sender ? candidate.gifter_purchase_id : candidate.giftee_purchase_id) === String(purchase.id),
    );
    if ((sender || receiver) && gift !== undefined) gifted.set(String(purchase.id), gift);
  }
  const gifteePurchases = byId(
    await rowsBy(
      "purchases",
      "id",
      [...gifted.entries()]
        .filter(([id]) => PurchaseFlags.isSet(byId(purchases).get(id)!.flags, "is_gift_sender_purchase"))
        .map(([, gift]) => gift.giftee_purchase_id)
        .filter((id) => id != null),
    ),
  );
  for (const giftee of gifteePurchases.values())
    if (giftee.subscription_id != null) throw notPorted("a gifted membership");
  const gifteeLicenses = await rowsBy("licenses", "purchase_id", [...gifteePurchases.keys()]);
  const preorders = byId(
    await rowsBy("preorders", "id", [
      ...new Set(purchases.map((purchase) => purchase.preorder_id).filter((id) => id != null)),
    ]),
  );
  const presentments = new Map(
    (await rowsBy("purchase_presentments", "purchase_id", ids)).map((row) => [String(row.purchase_id), row] as const),
  );
  const chargePresentments = byId(
    await rowsBy(
      "charge_presentments",
      "id",
      [...presentments.values()].map((row) => row.charge_presentment_id).filter((id) => id != null),
    ),
  );

  // variant_attributes: the habtm through base_variants_purchases
  const joins = await rowsBy("base_variants_purchases", "purchase_id", ids);
  const variantRows = byId(
    await rowsBy("base_variants", "id", [...new Set(joins.map((join) => join.base_variant_id))]),
  );
  const variants = new Map<string, Row[]>();
  for (const join of joins) {
    const variant = variantRows.get(String(join.base_variant_id));
    if (variant === undefined) continue;
    if (variant.type === "Sku") throw notPorted("a SKU");
    variants.set(String(join.purchase_id), [...(variants.get(String(join.purchase_id)) ?? []), variant]);
  }
  for (const list of variants.values()) if (list.length > 1) throw notPorted("several variants");
  const categories = byId(
    await rowsBy("variant_categories", "id", [
      ...new Set([...variantRows.values()].map((variant) => variant.variant_category_id).filter((id) => id != null)),
    ]),
  );
  const linkIds = [...links.keys()];
  const aliveCategoryRows =
    linkIds.length === 0
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT DISTINCT ${column("variant_categories", "link_id")} AS link_id FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} IN (${inList(linkIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL`,
        );

  const customRows = await rowsBy("purchase_custom_fields", "purchase_id", ids);
  if (customRows.some((field) => field.field_type === "fileUpload" || field.field_type === "file"))
    throw notPorted("a file custom field");
  const customFields = new Map<string, Row[]>();
  for (const field of customRows)
    customFields.set(String(field.purchase_id), [...(customFields.get(String(field.purchase_id)) ?? []), field]);

  const driven = await rowsBy("utm_link_driven_sales", "purchase_id", ids);
  const utmRows = byId(await rowsBy("utm_links", "id", [...new Set(driven.map((sale) => sale.utm_link_id))]));
  const utmLinks = new Map(
    driven
      .map((sale) => [String(sale.purchase_id), utmRows.get(String(sale.utm_link_id))!] as const)
      .filter(([, utm]) => utm !== undefined),
  );

  // purchase.order goes through order_purchases
  const orderPurchases = await rowsBy("order_purchases", "purchase_id", ids);
  const orderOf = new Map(orderPurchases.map((row) => [String(row.purchase_id), String(row.order_id)] as const));
  const carts = await rowsBy("carts", "order_id", [...new Set(orderOf.values())]);
  // Purchase#sent_abandoned_cart_email?: a reminder this seller sent for the order's cart
  const abandoned =
    carts.length === 0
      ? []
      : await rowsBy(
          "sent_abandoned_cart_emails",
          "cart_id",
          carts.map((cart) => cart.id),
        );
  const installments = byId(
    await rowsBy("installments", "id", [...new Set(abandoned.map((email) => email.installment_id))]),
  );
  const cartsByOrder = new Map(carts.map((cart) => [String(cart.order_id), cart] as const));
  const abandonedCartOrders = new Set<string>();
  for (const purchase of purchases) {
    const cart = cartsByOrder.get(orderOf.get(String(purchase.id)) ?? "");
    if (cart === undefined) continue;
    const seller = String(loadedLinkUser(links, purchase));
    if (
      abandoned.some(
        (email) =>
          String(email.cart_id) === String(cart.id) &&
          String(installments.get(String(email.installment_id))?.seller_id) === seller,
      )
    )
      abandonedCartOrders.add(String(purchase.id));
  }

  const stats = await rowsBy("product_review_stats", "link_id", linkIds);
  const subscriptionIds = [
    ...new Set(purchases.map((purchase) => purchase.subscription_id).filter((id) => id != null)),
  ];
  const originals =
    subscriptionIds.length === 0
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "subscription_id")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} IN (${inList(subscriptionIds)}) AND ${PurchaseFlags.condition("is_original_subscription_purchase", true)} ORDER BY ${column("purchases", "id")} ASC`,
        );
  const trueOriginal = new Map<string, bigint | number>();
  for (const original of originals)
    if (!trueOriginal.has(String(original.subscription_id)))
      trueOriginal.set(String(original.subscription_id), original.id);
  const subscriptions = byId(
    await rowsBy("subscriptions", "id", [
      ...new Set(purchases.map((purchase) => purchase.subscription_id).filter((id) => id != null)),
    ]),
  );
  for (const subscription of subscriptions.values()) {
    if (
      SubscriptionFlags.isSet(subscription.flags, "is_installment_plan") ||
      SubscriptionFlags.isSet(subscription.flags, "renewal_disabled_due_to_indian_card_mandate")
    )
      throw notPorted("an installment plan or a card mandate");
  }
  const paymentOptions = await rowsBy("payment_options", "subscription_id", [...subscriptions.keys()]);
  const lastOptions = byId(
    await rowsBy(
      "payment_options",
      "id",
      [...subscriptions.values()].map((subscription) => subscription.last_payment_option_id).filter((id) => id != null),
    ),
  );
  const priceIds = new Set<unknown>(purchases.map((purchase) => purchase.price_id).filter((id) => id != null));
  // Subscription#price: last_payment_option, else the last alive payment option
  const optionOf = (subscription: Row): Row => {
    const chosen =
      subscription.last_payment_option_id == null
        ? [...paymentOptions]
            .reverse()
            .find((option) => String(option.subscription_id) === String(subscription.id) && option.deleted_at == null)
        : lastOptions.get(String(subscription.last_payment_option_id));
    if (chosen === undefined) throw notPorted("a subscription with no payment option");
    if (chosen.product_installment_plan_id != null) throw notPorted("an installment plan payment option");
    return chosen;
  };
  const subscriptionOption = new Map(
    [...subscriptions.values()].map((subscription) => [String(subscription.id), optionOf(subscription)] as const),
  );
  for (const option of subscriptionOption.values()) if (option.price_id != null) priceIds.add(option.price_id);
  const priceRows = byId(await rowsBy("prices", "id", [...priceIds]));
  const prices = new Map<string, Row>();
  for (const purchase of purchases) {
    const own = purchase.price_id == null ? undefined : priceRows.get(String(purchase.price_id));
    const viaSubscription =
      purchase.subscription_id == null
        ? undefined
        : priceRows.get(String(subscriptionOption.get(String(purchase.subscription_id))!.price_id));
    if (purchase.price_id != null && own === undefined) throw notPorted("a missing price row");
    const chosen = own ?? viaSubscription;
    if (chosen !== undefined) prices.set(String(purchase.id), chosen);
    else if (purchase.subscription_id != null) throw notPorted("a subscription with no price");
  }
  // variant.prices.alive.is_buy.find_by(recurrence:) for a tiered membership's chosen tier
  const tierPrices = new Map<string, Row>();
  for (const purchase of purchases) {
    const variant = variants.get(String(purchase.id))?.[0];
    const price = prices.get(String(purchase.id));
    if (variant === undefined || !LinkFlags.isSet(links.get(String(purchase.link_id))!.flags, "is_tiered_membership"))
      continue;
    const [found] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${variant.id} AND ${column("prices", "deleted_at")} IS NULL AND (${column("prices", "flags")} & 1) = 0 AND ${price?.recurrence == null ? Prisma.sql`${column("prices", "recurrence")} IS NULL` : Prisma.sql`${column("prices", "recurrence")} = ${price.recurrence}`} LIMIT 1`,
    );
    if (found !== undefined) tierPrices.set(String(purchase.id), found);
  }
  const first = <K extends string>(rows: Row[], key: K) =>
    new Map(rows.map((row) => [String(row[key]), row] as const).reverse());
  return {
    links,
    sellers,
    purchasers,
    variants,
    categories,
    hasAliveCategories: new Set(aliveCategoryRows.map((row) => String(row.link_id))),
    customFields,
    tips: first(await rowsBy("tips", "purchase_id", ids), "purchase_id"),
    utmLinks,
    shipments: first(await rowsBy("shipments", "purchase_id", ids), "purchase_id"),
    licenses: first(await rowsBy("licenses", "purchase_id", ids), "purchase_id"),
    reviews: first(
      await rowsBy("product_reviews", "purchase_id", [...ids, ...trueOriginal.values(), ...gifteePurchases.keys()]),
      "purchase_id",
    ),
    merchantAccountOf,
    zipTaxRates: byId(
      await rowsBy("zip_tax_rates", "id", [
        ...new Set(purchases.map((purchase) => purchase.zip_tax_rate_id).filter((id) => id != null)),
      ]),
    ),
    gifted,
    gifteePurchases,
    gifteeLicenses: first(gifteeLicenses, "purchase_id"),
    preorders,
    presentments,
    chargePresentments,
    presentmentRefundedCents,
    trueOriginal,
    reviewStats: first(stats, "link_id"),
    subscriptions,
    prices,
    tierPrices,
    ppp: first(await rowsBy("purchasing_power_parity_infos", "purchase_id", ids), "purchase_id"),
    refundedCents,
    abandonedCartOrders,
  };
}

// Purchase#transaction_url_for_seller: nil for a sale on Gumroad's own Stripe account, else the processor's dashboard URL.
function transactionUrlForSeller(purchase: Row, merchantAccount: Row | null): string | null {
  if (!present(purchase.charge_processor_id) || !present(purchase.stripe_transaction_id)) return null;
  const connect = merchantAccount !== null && isStripeConnectAccount(merchantAccount as MerchantAccountRow);
  const gumroadAccount = merchantAccount !== null && merchantAccount.user_id == null;
  if (gumroadAccount || (purchase.charge_processor_id === "stripe" && !connect)) return null;
  const production = railsEnv() === "production";
  const id = String(purchase.stripe_transaction_id);
  if (purchase.charge_processor_id === "stripe")
    return `https://manage.stripe.com/${production ? "" : "test/"}payments/${id}`;
  if (purchase.charge_processor_id === "paypal")
    return `https://${production ? "history" : "sandbox"}.paypal.com/us/cgi-bin/webscr?cmd=_history-details-from-hub&id=${id}`;
  throw notPorted("a transaction URL");
}

// `Time#to_fs(:long_formatted_datetime)`: "%e %b %Y %l:%M %p" in the seller's zone.
function longFormattedDatetime(zone: string, instant: Date): string {
  const iso = instantInTimeZoneIso8601(zone, instant);
  const [, year, month, day, hour, minute] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(iso)!;
  const twelve = Number(hour) % 12 === 0 ? 12 : Number(hour) % 12;
  return `${String(Number(day)).padStart(2, " ")} ${MONTHS[Number(month) - 1]} ${year} ${String(twelve).padStart(2, " ")}:${minute} ${Number(hour) < 12 ? "AM" : "PM"}`;
}

export const castBoolean = (value: unknown): boolean | null => {
  if (value == null || value === "") return null;
  return !["0", "f", "F", "false", "FALSE", "off", "OFF", "false "].includes(String(value));
};

export type PurchaseJsonOptions = {
  now?: Date;
  // The is_following value to use per purchase id (the controller's lookup); `is_following?` is read when absent.
  isFollowing?: (purchase: Row) => boolean | Promise<boolean>;
  // as_json_for_license: included keys are renamed there; nothing differs here.
};

// Purchase#as_json(version: 2, include_buyer_presentment: true)
export async function purchasesAsJsonV2(
  purchases: Row[],
  options: PurchaseJsonOptions = {},
): Promise<Record<string, unknown>[]> {
  if (purchases.length === 0) return [];
  const loaded = await load(purchases);
  const now = options.now ?? new Date();
  const result: Record<string, unknown>[] = [];
  for (const purchase of purchases) result.push(await one(purchase, loaded, now, options));
  return result;
}

async function one(
  purchase: Row,
  loaded: Loaded,
  now: Date,
  options: PurchaseJsonOptions,
): Promise<Record<string, unknown>> {
  const id = String(purchase.id);
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const link = loaded.links.get(String(purchase.link_id))!;
  const seller = loaded.sellers.get(String(purchase.seller_id))!;
  const purchaser =
    purchase.purchaser_id == null ? null : (loaded.purchasers.get(String(purchase.purchaser_id)) ?? null);
  const variant = loaded.variants.get(id)?.[0];
  const category = variant === undefined ? undefined : loaded.categories.get(String(variant.variant_category_id));
  const currency = String(purchase.displayed_price_currency_type);
  const rate = present(purchase.rate_converted_to_usd) ? Number(purchase.rate_converted_to_usd) : undefined;
  const refunded = truthy(purchase.stripe_refunded);
  const chargedBack = purchase.chargeback_date != null;
  const chargebackReversed = flags("chargeback_reversed");
  const priceCents = num(purchase.price_cents);
  const displayedPriceCents = num(purchase.displayed_price_cents);
  const quantity = num(purchase.quantity ?? 1);
  const isPhysical = LinkFlags.isSet(link.flags, "is_physical");
  const refundedCents = loaded.refundedCents.get(id) ?? 0;
  const refundable = CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id) ? priceCents - refundedCents : 0;
  // Purchase#has_tax_label?, #tax_label(include_tax_rate: false), #tax_included_in_price
  const hasTaxLabel =
    flags("was_purchase_taxable") || num(purchase.gumroad_tax_cents) > 0 || num(purchase.tax_cents) > 0;
  let taxLabel: string | undefined;
  if (hasTaxLabel) {
    const country =
      purchase.zip_tax_rate_id == null ? undefined : loaded.zipTaxRates.get(String(purchase.zip_tax_rate_id))?.country;
    const named =
      typeof country === "string" &&
      [
        EU_VAT_APPLICABLE_COUNTRY_CODES,
        NORWAY_VAT_APPLICABLE_COUNTRY_CODES,
        COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
        COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
        GST_APPLICABLE_COUNTRY_CODES,
      ].some((codes) => codes.has(country));
    taxLabel = named ? taxNameFor(country as string) : "Sales tax";
  }
  const merchantAccount = loaded.merchantAccountOf(purchase);
  const paymentProcessor = present(purchase.paypal_order_id)
    ? "paypal"
    : merchantAccount !== null && isStripeConnectAccount(merchantAccount as MerchantAccountRow)
      ? "stripe_connect"
      : undefined;
  const gift = loaded.gifted.get(id);
  const giftee = gift === undefined ? undefined : loaded.gifteePurchases.get(String(gift.giftee_purchase_id));
  const preorder = purchase.preorder_id == null ? undefined : loaded.preorders.get(String(purchase.preorder_id));
  const presentment = loaded.presentments.get(id);
  const subscription =
    purchase.subscription_id == null ? undefined : loaded.subscriptions.get(String(purchase.subscription_id));
  const price = loaded.prices.get(id);
  // Purchase#original_product_review: the review sits on the subscription's true original purchase
  const reviewHolder =
    subscription !== undefined
      ? String(loaded.trueOriginal.get(String(subscription.id)))
      : flags("is_gift_sender_purchase")
        ? String(gift?.giftee_purchase_id)
        : id;
  const review = loaded.reviews.get(reviewHolder);
  const chargeOccurrence = subscription !== undefined && subscription.charge_occurrence_count === 1 ? 1 : null;
  // format_price_in_cents: the amount in the displayed currency with the recurrence of price_for_recurrence
  const formatPrice = (cents: number): string => {
    let text = formatJustPriceInCents(cents, currency);
    if (price === undefined) return text;
    if (price.recurrence != null && chargeOccurrence === 1) return `${text} once`;
    if (price.recurrence != null) text = `${text} ${RECURRENCE_LONG_INDICATOR[price.recurrence as string]}`;
    return chargeOccurrence === null ? text : `${text} x ${chargeOccurrence}`;
  };
  const tip = loaded.tips.get(id);
  const utm = loaded.utmLinks.get(id);
  const shipment = loaded.shipments.get(id);
  // linked_license: the purchase's own license, or a gift sender's giftee license
  // Purchase#license_key is the license's serial, for a licensed product whose chosen variant has no content of its own
  const licensedProduct = LinkFlags.isSet(link.flags, "is_licensed");
  if (
    licensedProduct &&
    !isPhysical &&
    (variant !== undefined || (gift !== undefined && loaded.hasAliveCategories.has(String(purchase.link_id))))
  )
    throw notPorted("variant-level license key content");
  const ownLicense = licensedProduct ? loaded.licenses.get(id) : undefined;
  const gifteeLicense =
    licensedProduct && flags("is_gift_sender_purchase") && giftee !== undefined
      ? loaded.gifteeLicenses.get(String(giftee.id))
      : undefined;
  const license = present(ownLicense?.serial) ? ownLicense : present(gifteeLicense?.serial) ? gifteeLicense : undefined;
  const customFields = (loaded.customFields.get(id) ?? []).map((field) => ({
    name: field.name,
    value:
      field.field_type === "checkbox" || field.field_type === "terms"
        ? castBoolean(field.value)
        : String(field.value ?? ""),
  }));
  const geo = purchase.country == null || purchase.state == null ? geoIpLookup(purchase.ip_address) : null;
  const country = purchase.country == null ? (geo?.countryName ?? null) : purchase.country;
  const hasInvoice = priceCents !== 0 || num(purchase.shipping_cents) !== 0;
  const emailDisplay = purchaser !== null && present(purchaser.email) ? purchaser.email : purchase.email;
  const formatted = formatPrice(displayedPriceCents);
  const formattedTotal = formatPrice(await usdCentsToCurrency(currency, priceCents, rate));
  const following =
    options.isFollowing === undefined
      ? (await followingEmails(purchase.seller_id, [purchase.email])).size > 0
      : await options.isFollowing(purchase);

  const json: Record<string, unknown> = {
    id: encrypt(purchase.id),
    email: emailDisplay,
    seller_id: encrypt(seller.id),
    timestamp: `${timeAgoInWords(purchase.created_at, now)} ago`,
    daystamp: longFormattedDatetime(seller.timezone, purchase.created_at),
    created_at: timeJson(purchase.created_at),
    link_name: undefined,
    product_name: link.name,
    product_has_variants: loaded.hasAliveCategories.has(String(purchase.link_id)),
    price: priceCents,
    gumroad_fee: num(purchase.fee_cents),
    is_bundle_purchase: flags("is_bundle_purchase"),
    is_bundle_product_purchase: flags("is_bundle_product_purchase"),
    formatted_display_price: formatted,
    transaction_url_for_seller: transactionUrlForSeller(purchase, merchantAccount) ?? undefined,
    formatted_total_price: formattedTotal,
    currency_symbol: symbolFor(currency),
    currency,
    amount_refundable_in_currency: moneyFormatterFormat(
      await usdCentsToCurrency(currency, refundable, rate),
      currency,
      { noCentsIfWhole: true, symbol: false },
    ),
    link_id: undefined,
    product_id: encrypt(link.id),
    product_permalink: link.unique_permalink,
    refunded: purchase.stripe_refunded == null ? undefined : refunded,
    partially_refunded:
      purchase.stripe_partially_refunded == null ? undefined : truthy(purchase.stripe_partially_refunded),
    chargedback: chargedBack && !chargebackReversed,
    purchase_email: purchase.email,
    giftee_email: gift?.giftee_email,
    gifter_email: gift?.gifter_email,
    full_name: present((purchase.full_name ?? "").trim()) ? purchase.full_name.trim() : (purchaser?.name ?? undefined),
    street_address: purchase.street_address,
    city: purchase.city,
    state: purchase.state == null ? (geo?.regionName ?? undefined) : purchase.state,
    zip_code: purchase.zip_code,
    country: country ?? undefined,
    country_iso2: alpha2ByName(country) ?? undefined,
    paid: priceCents !== 0,
    has_variants: variant !== undefined,
    variants: variant === undefined ? undefined : { [String(category?.title)]: variant.name },
    variants_and_quantity: variantsAndQuantity(variant, quantity),
    has_custom_fields: customFields.length > 0,
    custom_fields: Object.fromEntries(customFields.map((field) => [field.name, field.value])),
    order_id: encryptNumeric(num(purchase.id)),
    is_product_physical: isPhysical,
    purchaser_id: purchaser?.external_id ?? undefined,
    is_recurring_billing: LinkFlags.isSet(link.flags, "is_recurring_billing"),
    can_contact: truthy(purchase.can_contact),
    is_following: following,
    disputed: chargedBack,
    dispute_won: chargebackReversed,
    is_additional_contribution: flags("is_additional_contribution"),
    discover_fee_charged: flags("was_discover_fee_charged"),
    is_upgrade_purchase: flags("is_upgrade_purchase"),
    ppp:
      flags("is_purchasing_power_parity_discounted") && loaded.ppp.has(id)
        ? { country: purchase.ip_country, discount: `${Math.round((1 - num(loaded.ppp.get(id)!.factor)) * 100)}%` }
        : undefined,
    is_more_like_this_recommended: purchase.recommended_by === "more_like_this",
    is_gift_sender_purchase: flags("is_gift_sender_purchase"),
    is_gift_receiver_purchase: flags("is_gift_receiver_purchase"),
    referrer: purchase.referrer,
    invoice_url: hasInvoice ? invoiceUrl(purchase) : undefined,
    paypal_refund_expired:
      purchase.card_type === "paypal" && purchase.created_at.getTime() < monthsAgo(now, PAYPAL_REFUND_WINDOW_MONTHS),
    utm_source: utm?.utm_source,
    utm_medium: utm?.utm_medium,
    utm_campaign: utm?.utm_campaign,
    utm_term: utm?.utm_term,
    utm_content: utm?.utm_content,
    tip_cents: tip === undefined ? undefined : num(tip.value_usd_cents),
    tax_label: taxLabel,
    tax_included_in_price: flags("was_purchase_taxable") ? !flags("was_tax_excluded_from_price") : undefined,
    tax_cents: num(purchase.gumroad_tax_cents) > 0 ? num(purchase.gumroad_tax_cents) : num(purchase.tax_cents),
    shipping_cents: num(purchase.shipping_cents),
    payment_processor: paymentProcessor,
    processor_transaction_id: paymentProcessor === undefined ? undefined : purchase.stripe_transaction_id,
    processor_fee_cents: paymentProcessor === undefined ? undefined : purchase.processor_fee_cents,
    processor_fee_currency: paymentProcessor === undefined ? undefined : purchase.processor_fee_cents_currency,
    access_revoked: flags("is_access_revoked"),
    subscription_duration: price?.recurrence ?? undefined,
    variants_price_cents:
      variant === undefined
        ? 0
        : LinkFlags.isSet(link.flags, "is_tiered_membership")
          ? num(loaded.tierPrices.get(id)?.price_cents ?? 0)
          : num(variant.price_difference_cents ?? 0),
    review: review === undefined ? undefined : review.message,
    preorder_authorization_time:
      preorder !== undefined && !flags("is_preorder_authorization") ? timeJson(preorder.created_at) : undefined,
    cancellation_date: subscription === undefined ? undefined : timeJson(subscription.user_requested_cancellation_at),
    subscription_end_date:
      subscription === undefined
        ? undefined
        : dateOf(
            subscription.ended_at ?? subscription.cancelled_at ?? subscription.failed_at ?? subscription.deactivated_at,
          ),
    sent_abandoned_cart_email: loaded.abandonedCartOrders.has(id),
    ...(presentment === undefined
      ? {}
      : {
          buyer_presentment: {
            currency: presentment.presentment_currency,
            price_cents: num(presentment.presentment_price_cents),
            tip_cents: num(presentment.presentment_tip_cents),
            seller_tax_cents: num(presentment.presentment_seller_tax_cents),
            gumroad_tax_cents: num(presentment.presentment_gumroad_tax_cents),
            shipping_cents: num(presentment.presentment_shipping_cents),
            total_cents: num(presentment.presentment_total_cents),
            fx_rate:
              presentment.charge_presentment_id == null ||
              loaded.chargePresentments.get(String(presentment.charge_presentment_id))?.fx_rate == null
                ? null
                : bigDecimalToS(loaded.chargePresentments.get(String(presentment.charge_presentment_id))!.fx_rate),
            refunded_cents: loaded.presentmentRefundedCents.get(id) ?? 0,
          },
        }),
  };
  for (const key of Object.keys(json)) if (json[key] === undefined || json[key] === null) delete json[key];

  json.card = {
    visual: purchase.card_visual,
    type: purchase.card_type,
    bin: null,
    expiry_month: null,
    expiry_year: null,
  };
  json.product_rating = review?.rating ?? null;
  if (LinkFlags.isSet(link.flags, "display_product_reviews")) {
    const stat = loaded.reviewStats.get(String(purchase.link_id));
    json.reviews_count = stat === undefined ? 0 : num(stat.reviews_count);
    json.average_rating = stat === undefined ? 0 : num(stat.average_rating);
  }
  if (subscription !== undefined) {
    const alive =
      subscription.failed_at == null &&
      subscription.ended_at == null &&
      (subscription.cancelled_at == null || subscription.cancelled_at.getTime() > now.getTime());
    const trialEnds: Date | null = subscription.free_trial_ends_at ?? null;
    json.subscription_id = encrypt(subscription.id);
    json.cancelled = subscription.cancelled_at != null || subscription.failed_at != null;
    json.dead = !alive;
    json.ended = subscription.ended_at != null;
    json.free_trial_ended = trialEnds === null ? null : trialEnds.getTime() <= now.getTime();
    json.free_trial_ends_on = trialEnds === null ? null : formattedDateAbbrevMonth(trialEnds);
    json.recurring_charge = !flags("is_original_subscription_purchase");
  }
  if (shipment !== undefined) {
    json.shipped = shipment.shipped_at != null;
    json.tracking_url =
      shipment.tracking_url == null || shipment.tracking_url === ""
        ? null
        : (() => {
            throw notPorted("a tracking URL");
          })();
  }
  if (preorder !== undefined) {
    json.preorder_cancelled = preorder.state === "cancelled";
    json.is_preorder_authorization = flags("is_preorder_authorization");
    json.is_in_preorder_state = LinkFlags.isSet(link.flags, "is_in_preorder_state");
  }
  if (flags("was_discover_fee_charged"))
    json.discover_fee_percentage = Math.trunc(num(purchase.discover_fee_per_thousand) / 10);

  if (license !== undefined) {
    json.license_key = license.serial;
    json.license_id = encrypt(license.id);
    json.license_disabled = license.disabled_at != null;
    json.license_uses = license.uses;
    json.is_multiseat_license = flags("is_multiseat_license");
  }
  if (num(purchase.shipping_cents) > 0)
    json.formatted_shipping_amount = formatPrice(
      await usdCentsToCurrency(String(link.price_currency_type), num(purchase.shipping_cents), rate),
    );
  json.quantity = quantity;
  return json;
}

// BigDecimal#to_s as ActiveSupport formats it: plain digits without trailing zeros, at least one decimal.
function bigDecimalToS(value: unknown): string {
  const text = String(value);
  if (!text.includes(".")) return `${text}.0`;
  const trimmed = text.replace(/0+$/u, "");
  return trimmed.endsWith(".") ? `${trimmed}0` : trimmed;
}

const jsonData = (row: Row): Record<string, unknown> => {
  try {
    const parsed: unknown = typeof row.json_data === "string" && row.json_data !== "" ? JSON.parse(row.json_data) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw notPorted("a refund whose json_data is not JSON");
  }
};

const loadedLinkUser = (links: Map<string, Row>, purchase: Row) => links.get(String(purchase.link_id))!.user_id;
// Time#to_date as a Date's JSON ("YYYY-MM-DD", UTC)
const dateOf = (time: Date | null | undefined): string | undefined =>
  time == null ? undefined : time.toISOString().slice(0, 10);

// CGI.escape
export const cgiEscape = (value: string): string =>
  encodeURIComponent(value)
    .replaceAll("%20", "+")
    .replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function variantsAndQuantity(variant: Row | undefined, quantity: number): string {
  const names = variant === undefined ? [] : [String(variant.name)];
  if (quantity > 1) names.push(`Qty: ${quantity}`);
  return names.length > 0 ? `(${names.join(", ")})` : "";
}

function monthsAgo(now: Date, months: number): number {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

// new_purchase_invoice_url(external_id, email:, host: UrlService.domain_with_protocol)
function invoiceUrl(purchase: Row): string {
  const { protocol, domain } = domainConfig();
  return `${protocol}://${domain}/purchases/${encrypt(purchase.id)}/invoice/new?email=${cgiEscape(String(purchase.email))}`;
}
