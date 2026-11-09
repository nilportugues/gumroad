// CustomersController#index (`/customers`, `/customers/:link_id`): fetch_sales over PurchaseSearchService, CustomersPresenter
// and CustomerPresenter#customer (app/presenters/customer{,s}_presenter.rb).
//
// Handed back to Rails (HandBackToRails) when a customer on the page needs a reading the port does not make: a member or
// installment plan (current subscription price, remaining charges), a sent gift whose
// recipient holds a license, a physical product, a Sku or a tier, several options on one sale, a collaborator sale that also credits a direct affiliate, a UTM link (`utm_url` is built by Addressable), a non-USD price without a
// stored rate or in a currency the port has no table for, a refund whose json_data is not plain JSON, a commission
// with files, a review video, a custom field file, a seller whose ping endpoints must be checked (`can_ping`), and a
// sale charged through a processor transaction URL (Stripe Connect, PayPal, Braintree).
import { Prisma, type Purchase, type User } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { formattedDollarAmount, usdCentsToCurrency } from "../../models/concerns/currency-helper.ts";
import LINK_DATA from "../../models/link-data.generated.json" with { type: "json" };
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { COUNTRIES, historicalNames, isBlockedCountry } from "../../models/compliance-countries.ts";
import { LinkFlags } from "../../models/link.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "../../models/merchant-account.ts";
import { originalPrice } from "../../models/offer-code.ts";
import { secureExternalId } from "../../models/secure-external-id.ts";
import { PurchaseRecord } from "../../models/purchase-pricing.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { UserFlags } from "../../models/user.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { extractDomain } from "../../search/referrer.ts";
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "../../policies/seller-context.ts";

export const CUSTOMERS_PER_PAGE = 20;
// Keep pagination within Elasticsearch's index.max_result_window.
export const MAX_RESULT_WINDOW = 10_000;
// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];
const KNOWN_CURRENCIES = LINK_DATA.currencies as Record<string, unknown>;
// A stored rate String#to_f reads the way Number does.
const PLAIN_RATE = /^\d+(?:\.\d+)?$/u;
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
// ChargeProcessor.charge_processor_ids
const CHARGE_PROCESSOR_IDS = ["stripe", "braintree", "paypal"];
// License::MANAGE_SECURE_ID_SCOPE, License::MANAGE_TOKEN_TTL
const LICENSE_SCOPE = "manage_license";
const LICENSE_TTL_MS = 7 * 24 * 3600 * 1000;
// COMMON_REFERRERS_NAMES (config/initializers/004_constants.rb)
const COMMON_REFERRERS_NAMES: Record<string, string> = {
  "dribbble.com": "Dribbble",
  "facebook.com": "Facebook",
  "google.com": "Google",
  "gumroad.com": "Gumroad",
  "pinterest.com": "Pinterest",
  "reddit.com": "Reddit",
  "shutterstock.com": "Shutterstock",
  "tumblr.com": "Tumblr",
  "api.twitter.com": "Twitter",
  "t.co": "Twitter",
  "twitter.com": "Twitter",
  "youtube.com": "Youtube",
};
const REFERRER_NAMES = new Map(Object.entries(COMMON_REFERRERS_NAMES));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const num = (value: unknown): number => Number(value);
const exists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;

// String#to_i
export function rubyToI(value: string | undefined): number {
  const match = /^\s*[-+]?\d[\d_]*/u.exec(value ?? "");
  return match ? Number(match[0].replaceAll("_", "")) : 0;
}

export type CustomersParams = {
  linkId: string | null;
  page: string | undefined;
  query: string | undefined;
  boughtFrom: string | undefined;
  // `GET /customers/paged`: the sort ES takes ahead of the date order, and the 1-indexed page the answer reports.
  sort?: Record<string, unknown> | null;
  paged?: boolean;
  // PurchaseSearchService options of the filter box (`GET /customers/paged`).
  filters?: Record<string, unknown>;
};

// `from` is 0-indexed; page 500 (1-indexed) is the last legal ES window (9980).
export const pageOffset = (page: string | undefined) => Math.min(Math.max(rubyToI(page), 0), MAX_RESULT_WINDOW / CUSTOMERS_PER_PAGE - 1) * CUSTOMERS_PER_PAGE;
export const totalPages = (total: number) => Math.min(Math.ceil(total / CUSTOMERS_PER_PAGE), MAX_RESULT_WINDOW / CUSTOMERS_PER_PAGE);

// `Link.fetch(params[:link_id])`: nil for an unknown permalink, which lists every customer.
async function fetchProduct(linkId: string | null): Promise<Row | null> {
  if (linkId === null) return null;
  const [row] = await selectRows<Row>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "unique_permalink")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${linkId} AND ${column("links", "deleted_at")} IS NULL LIMIT 1`,
  );
  return row ?? null;
}

// CustomersController#fetch_sales for the index action.
async function fetchSales(seller: User, params: CustomersParams, product: Row | null) {
  const options: Record<string, unknown> = {
    seller: { id: Number(seller.id) },
    country: historicalNames(params.boughtFrom).length > 0 ? historicalNames(params.boughtFrom) : undefined,
    state: NON_GIFT_SUCCESS_STATES,
    any_products_or_variants: product ? { products: [{ id: Number(product.id) }] } : {},
    exclude_non_original_subscription_purchases: true,
    exclude_giftees: true,
    exclude_bundle_product_purchases: true,
    exclude_commission_completion_purchases: true,
    from: pageOffset(params.page),
    size: CUSTOMERS_PER_PAGE,
    sort: [{ created_at: { order: "desc" } }, { id: { order: "desc" } }],
    track_total_hits: true,
    seller_query: params.query,
    ...params.filters,
  };
  if (params.sort) (options.sort as unknown[]).unshift(params.sort);
  return PurchaseSearchService.process(options);
}

// ---- reads behind a customer ----

const inList = (ids: unknown[]) => Prisma.join(ids as (bigint | number)[]);

async function rowsBy(tableName: string, columnName: string, ids: unknown[], extra: Prisma.Sql = Prisma.empty): Promise<Row[]> {
  if (ids.length === 0) return [];
  return selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${inList(ids)})${extra} ORDER BY ${column(tableName, "id")} ASC`);
}

const groupBy = (rows: Row[], key: string) => {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) grouped.set(String(row[key]), [...(grouped.get(String(row[key])) ?? []), row]);
  return grouped;
};
const byId = (rows: Row[]) => new Map(rows.map((row) => [String(row.id), row]));

type Loaded = {
  purchases: Row[];
  links: Map<string, Row>;
  hasAliveVariants: Set<string>;
  offerCodes: Map<string, Row>;
  // Purchases with a PurchaseOfferCodeDiscount (`has_cached_offer_code?`), whose discount is the cached one, not the code's.
  cachedDiscounts: Set<string>;
  // The option each purchase picked (`variant_attributes.first`), by purchase id.
  variants: Map<string, Row>;
  // `upsell_purchase&.upsell&.name`, by purchase id.
  upsellNames: Map<string, string | null>;
  affiliates: Map<string, Row>;
  affiliateUsers: Map<string, Row>;
  licenses: Map<string, Row>;
  reviews: Map<string, Row>;
  responses: Map<string, Row>;
  customFields: Map<string, Row[]>;
  fieldNames: Map<string, Row>;
  tips: Map<string, Row>;
  urlRedirects: Map<string, Row>;
  purchasers: Map<string, Row>;
  calls: Map<string, Row>;
  ppp: Map<string, Row>;
  merchantAccounts: Map<string, Row>;
  // Purchase#amount_refunded_cents: the sum of the effective refunds.
  refundedCents: Map<string, number>;
  gifts: Map<string, Row>;
  // The gift a receiver's purchase was delivered through (`gift_received`), by the receiver's purchase id.
  receivedGifts: Map<string, Row>;
  // The ids of the preorders the page's purchases belong to (`purchase.preorder.present?`).
  preorderIds: Set<string>;
};

// Refund#effective?: a failed or canceled refund counts unless its balance debits were reversed.
export function refundIsEffective(refund: Row): boolean {
  if (!TERMINAL_FAILURE_STATUSES.includes(refund.status)) return true;
  let data: unknown = {};
  try {
    if (typeof refund.json_data === "string" && refund.json_data !== "") data = JSON.parse(refund.json_data);
  } catch {
    throw new HandBackToRails();
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new HandBackToRails();
  const reversed = (data as Record<string, unknown>).balance_reversed_on_failure;
  if (reversed !== undefined && reversed !== null && typeof reversed !== "boolean") throw new HandBackToRails();
  return reversed !== true;
}

// `purchase.upsell_purchase&.upsell&.name` for each purchase that has an upsell purchase.
export async function upsellNamesFor(purchaseIds: unknown[]): Promise<Map<string, string | null>> {
  const upsellPurchases = await rowsBy("upsell_purchases", "purchase_id", purchaseIds);
  const upsells = byId(await rowsBy("upsells", "id", [...new Set(upsellPurchases.map((upsellPurchase) => upsellPurchase.upsell_id))]));
  return new Map(upsellPurchases.map((upsellPurchase) => [String(upsellPurchase.purchase_id), upsells.get(String(upsellPurchase.upsell_id))?.name ?? null] as const));
}

// Purchase.where(id: ids).in_order_of(:id, ids) with the associations CustomerPresenter reads, after handing back what it cannot.
async function load(ids: string[], seller: User): Promise<Loaded> {
  const rows = await rowsBy("purchases", "id", ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  const purchases = rows.sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);
  const purchaseIds = purchases.map((purchase) => purchase.id);

  const links = byId(await rowsBy("links", "id", [...new Set(purchases.map((purchase) => purchase.link_id))]));
  for (const link of links.values()) if (link.require_shipping) throw new HandBackToRails();
  for (const purchase of purchases) {
    if (purchase.subscription_id != null) throw new HandBackToRails();
    // credits_direct_affiliate?: a collaborator sale that also credits a direct affiliate splits the credit in two (json_data).
    if (purchase.affiliate_id != null && typeof purchase.json_data === "string" && purchase.json_data.includes("direct_affiliate_id")) throw new HandBackToRails();
    // usd_cents_to_currency converts the refundable amount at the rate stored on the sale; without one it would ask Redis.
    if (purchase.displayed_price_currency_type !== "usd" && !(typeof purchase.displayed_price_currency_type === "string" && purchase.displayed_price_currency_type in KNOWN_CURRENCIES && PLAIN_RATE.test(String(purchase.rate_converted_to_usd ?? "").trim()))) throw new HandBackToRails();
    const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
    if (flags("is_commission_deposit_purchase")) throw new HandBackToRails();
    if (flags("is_installment_payment")) throw new HandBackToRails();
  }
  for (const [tableName, columnName] of [
    ["utm_link_driven_sales", "purchase_id"],
    ["commissions", "deposit_purchase_id"],
  ] as const) {
    if (purchaseIds.length > 0 && (await exists(Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${inList(purchaseIds)}) LIMIT 1`))) throw new HandBackToRails();
  }

  const affiliates = byId(await rowsBy("affiliates", "id", [...new Set(purchases.map((purchase) => purchase.affiliate_id).filter((id) => id != null))]));
  const affiliateUsers = byId(await rowsBy("users", "id", [...new Set([...affiliates.values()].map((affiliate) => affiliate.affiliate_user_id).filter((id) => id != null))]));
  // `purchase.affiliate.affiliate_user` raises for an affiliate without a user, which is Rails' to answer.
  if ([...affiliates.values()].some((affiliate) => !affiliateUsers.has(String(affiliate.affiliate_user_id)))) throw new HandBackToRails();

  // A Sku (shipping) or a tier (`recurrence_price_values`) is Rails' to answer, and so is a purchase of several options, since
  // `variant_attributes.first` has no order.
  const picks = groupBy(await rowsBy("base_variants_purchases", "purchase_id", purchaseIds), "purchase_id");
  if ([...picks.values()].some((rows) => rows.length > 1)) throw new HandBackToRails();
  const variantRows = byId(await rowsBy("base_variants", "id", [...new Set([...picks.values()].flat().map((pick) => pick.base_variant_id))]));
  const variants = new Map([...picks].map(([purchaseId, [pick]]) => [purchaseId, variantRows.get(String(pick!.base_variant_id))] as const).filter((entry): entry is [string, Row] => entry[1] !== undefined));
  if (variants.size !== picks.size) throw new HandBackToRails();
  for (const [purchaseId, variant] of variants) {
    const link = links.get(String(purchases.find((purchase) => String(purchase.id) === purchaseId)!.link_id))!;
    if (variant.type !== "Variant" || LinkFlags.isSet(link.flags, "is_tiered_membership")) throw new HandBackToRails();
  }

  const upsellNames = await upsellNamesFor(purchaseIds);

  const refundedCents = new Map<string, number>();
  for (const refund of await rowsBy("refunds", "purchase_id", purchaseIds)) {
    if (!refundIsEffective(refund)) continue;
    const key = String(refund.purchase_id);
    refundedCents.set(key, (refundedCents.get(key) ?? 0) + num(refund.amount_cents ?? 0));
  }

  // Purchase#giftee_email reads the gift of a sender; its linked_license may be the recipient's, which is Rails' to answer.
  const senderIds = purchases.filter((purchase) => PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")).map((purchase) => purchase.id);
  const gifts = new Map((await rowsBy("gifts", "gifter_purchase_id", senderIds)).map((gift) => [String(gift.gifter_purchase_id), gift]));
  const receiverIds = purchases.filter((purchase) => PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")).map((purchase) => purchase.id);
  const receivedGifts = new Map((await rowsBy("gifts", "giftee_purchase_id", receiverIds)).map((gift) => [String(gift.giftee_purchase_id), gift]));
  const gifteeIds = [...gifts.values()].map((gift) => gift.giftee_purchase_id).filter((id) => id != null);
  if (gifteeIds.length > 0 && (await exists(Prisma.sql`SELECT 1 FROM ${table("licenses")} WHERE ${column("licenses", "purchase_id")} IN (${inList(gifteeIds)}) LIMIT 1`))) throw new HandBackToRails();

  const reviews = byId(await rowsBy("product_reviews", "purchase_id", purchaseIds));
  const reviewsByPurchase = new Map([...reviews.values()].map((review) => [String(review.purchase_id), review]));
  const reviewIds = [...reviews.values()].map((review) => review.id);
  if (reviewIds.length > 0 && (await exists(Prisma.sql`SELECT 1 FROM ${table("product_review_videos")} WHERE ${column("product_review_videos", "product_review_id")} IN (${inList(reviewIds)}) LIMIT 1`))) throw new HandBackToRails();
  const responses = new Map((await rowsBy("product_review_responses", "product_review_id", reviewIds)).map((response) => [String(response.product_review_id), response]));

  const customFields = groupBy(await rowsBy("purchase_custom_fields", "purchase_id", purchaseIds), "purchase_id");
  const fieldRows = [...customFields.values()].flat();
  if (fieldRows.some((field) => field.field_type === "fileUpload" || field.field_type === "file")) throw new HandBackToRails();
  const fieldNames = byId(await rowsBy("custom_fields", "id", [...new Set(fieldRows.map((field) => field.custom_field_id).filter((id) => id != null))]));

  // can_ping: a seller with ping endpoints (resource subscriptions or a legacy notification endpoint) is Rails' to answer.
  if (await exists(Prisma.sql`SELECT 1 FROM ${table("resource_subscriptions")} WHERE ${column("resource_subscriptions", "user_id")} = ${seller.id} LIMIT 1`)) throw new HandBackToRails();

  return {
    purchases,
    links,
    hasAliveVariants: await productsWithAliveVariants([...links.keys()]),
    receivedGifts,
    preorderIds: new Set((await rowsBy("preorders", "id", [...new Set(purchases.map((purchase) => purchase.preorder_id).filter((id) => id != null))])).map((preorder) => String(preorder.id))),
    variants,
    upsellNames,
    affiliates,
    affiliateUsers,
    cachedDiscounts: new Set((await rowsBy("purchase_offer_code_discounts", "purchase_id", purchaseIds)).map((discount) => String(discount.purchase_id))),
    offerCodes: byId(await rowsBy("offer_codes", "id", [...new Set(purchases.map((purchase) => purchase.offer_code_id).filter((id) => id != null))])),
    licenses: new Map((await rowsBy("licenses", "purchase_id", purchaseIds, Prisma.sql` AND ${column("licenses", "deleted_at")} IS NULL`)).map((license) => [String(license.purchase_id), license])),
    reviews: reviewsByPurchase,
    responses,
    customFields,
    fieldNames,
    tips: new Map((await rowsBy("tips", "purchase_id", purchaseIds)).map((tip) => [String(tip.purchase_id), tip])),
    urlRedirects: new Map((await rowsBy("url_redirects", "purchase_id", purchaseIds)).map((redirect) => [String(redirect.purchase_id), redirect])),
    purchasers: byId(await rowsBy("users", "id", [...new Set(purchases.map((purchase) => purchase.purchaser_id).filter((id) => id != null))])),
    calls: new Map((await rowsBy("calls", "purchase_id", purchaseIds)).map((call) => [String(call.purchase_id), call])),
    merchantAccounts: byId(await rowsBy("merchant_accounts", "id", [...new Set(purchases.map((purchase) => purchase.merchant_account_id).filter((id) => id != null))])),
    refundedCents,
    gifts,
    ppp: new Map((await rowsBy("purchasing_power_parity_infos", "purchase_id", purchaseIds)).map((info) => [String(info.purchase_id), info])),
  };
}

// `link.alive_variants.any?`: alive Variants of alive variant categories.
async function productsWithAliveVariants(linkIds: string[]): Promise<Set<string>> {
  if (linkIds.length === 0) return new Set();
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT DISTINCT ${column("variant_categories", "link_id")} AS link_id FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")}
      WHERE ${column("variant_categories", "link_id")} IN (${inList(linkIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant'`,
  );
  return new Set(rows.map((row) => String(row.link_id)));
}

// ---- Purchase readings ----

// Purchase#display_referrer
export function displayReferrer(purchase: Row, sellerUsername: string): string | null {
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const recommendedBy = purchase.recommended_by as string | null;
  if (recommendedBy === "library") return "Gumroad Library";
  if (flags("was_product_recommended") || flags("was_discover_fee_charged")) {
    switch (recommendedBy) {
      case "receipt":
        return "Gumroad Receipt";
      case "more_like_this":
        return "Gumroad Product Recommendations";
      case "product":
        return "Gumroad Product Page";
      case "wishlist":
        return "Gumroad Wishlist";
      default:
        return "Gumroad Discover";
    }
  }
  if (purchase.referrer === "direct") return "Direct";
  if (present(purchase.referrer)) {
    const domain = extractDomain(purchase.referrer);
    if (domain.startsWith(`${sellerUsername}.gumroad.`)) return "Profile";
    return REFERRER_NAMES.get(domain) ?? domain;
  }
  return null;
}

// Purchase#transaction_url_for_seller: nil unless the sale was charged outside Gumroad's own Stripe account.
function assertNoTransactionUrl(purchase: Row, merchantAccount: Row | null): void {
  if (!present(purchase.charge_processor_id) || !present(purchase.stripe_transaction_id)) return;
  // Purchase#charged_using_gumroad_merchant_account?
  const gumroadAccount = merchantAccount !== null && merchantAccount.user_id == null;
  const stripeWithoutConnect = purchase.charge_processor_id === "stripe" && !(merchantAccount !== null && isStripeConnectAccount(merchantAccount as MerchantAccountRow));
  if (gumroadAccount || stripeWithoutConnect) return;
  throw new HandBackToRails();
}

// Purchase#amount_refundable_cents_in_currency
export function refundableCents(purchase: Row, refundedCents: number, currency: string): Promise<number> {
  const refundable = CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id) ? num(purchase.price_cents) - refundedCents : 0;
  return usdCentsToCurrency(currency, refundable, currency === "usd" ? undefined : Number(String(purchase.rate_converted_to_usd).trim()));
}

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

type ShownCode = { amount_cents: number | null; amount_percentage: number | null; code: string | null };

// CustomerPresenter's `discount` (Purchase#original_offer_code) and `cents_before_offer_code`
// (Purchase#displayed_price_cents_before_offer_code(include_deleted: true)).
export async function offerCodeReading(purchase: Row, offerCode: Row | null, cached: boolean): Promise<{ discountCode: ShownCode | null; beforeOfferCode: number }> {
  const displayed = num(purchase.displayed_price_cents);
  const quantity = purchase.quantity ?? 1;
  // original_offer_code (include_deleted: false) hides a deleted code, the listed price (include_deleted: true) does not.
  const deleted = offerCode !== null && offerCode.deleted_at != null;
  if (cached) {
    // The cached discount carries its own amount, the pre-discount prices and once_per_cart, so PurchaseRecord reads it.
    const record = new PurchaseRecord(castRow<Purchase>("Purchase", purchase), null);
    const shown = await record.originalOfferCode(false);
    const cachedCode = (await (await record.purchaseOfferCodeDiscount())?.offerCode())?.row.code;
    return {
      discountCode: shown && cachedCode !== undefined ? { amount_cents: shown.amount_cents, amount_percentage: shown.amount_percentage, code: cachedCode } : null,
      beforeOfferCode: (await record.displayedPriceCentsBeforeOfferCode(true)) ?? displayed,
    };
  }
  const discountCode = offerCode && !deleted ? (offerCode as ShownCode) : null;
  if (!offerCode) return { discountCode, beforeOfferCode: displayed };
  const price = originalPrice({ amount_cents: offerCode.amount_cents, amount_percentage: offerCode.amount_percentage }, displayed);
  return { discountCode, beforeOfferCode: price === null ? displayed : price * quantity };
}

// Variant#to_option (BaseVariant#to_option for a Variant of a product that is not a membership: never closed to new buyers, no
// recurrence prices). quantity_left reads sales_count_for_inventory_cache, the column Ruby re-reads for a persisted variant.
export function variantOption(variant: Row, productName: string) {
  const max = variant.max_purchase_count;
  return {
    id: encrypt(variant.id),
    name: variant.name === "Untitled" ? productName : (variant.name ?? ""),
    quantity_left: max == null ? null : Math.max(num(max) - num(variant.sales_count_for_inventory_cache ?? 0), 0),
    description: variant.description ?? "",
    price_difference_cents: variant.price_difference_cents,
    recurrence_price_values: null,
    is_pwyw: variant.customizable_price === true || variant.customizable_price === 1,
    duration_in_minutes: variant.duration_in_minutes,
  };
}

// CustomerPresenter's `is_preorder`: the authorization of a preorder that still exists, not the purchase it was later charged as.
export function isPreorder(purchase: Row, preorderIds: Set<string>): boolean {
  return purchase.preorder_id != null && preorderIds.has(String(purchase.preorder_id)) && PurchaseFlags.isSet(purchase.flags, "is_preorder_authorization");
}

// Purchase#gift: the sender's gift_given, else the receiver's gift_received.
export function giftOf(purchase: Row, loaded: Pick<Loaded, "gifts" | "receivedGifts">): Row | undefined {
  const id = String(purchase.id);
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")) return loaded.gifts.get(id);
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")) return loaded.receivedGifts.get(id);
  return undefined;
}

// CustomerPresenter's `affiliate`: the affiliate's form_email, the credit this sale paid them (own_affiliate_credit_cents, with no
// direct affiliate to subtract) and the STI type.
export function affiliateJson(purchase: Row, affiliate: Row, user: Row) {
  return {
    email: present(user.unconfirmed_email) ? user.unconfirmed_email : present(user.email) ? user.email : null,
    amount: formattedDollarAmount(num(purchase.affiliate_credit_cents ?? 0)),
    type: affiliate.type,
  };
}

type Context = { seller: User; sellerUsername: string; sellerContext: SellerContext; loaded: Loaded };

async function customerJson(purchase: Row, { sellerUsername, sellerContext, loaded }: Context) {
  assertNoTransactionUrl(purchase, purchase.merchant_account_id == null ? null : (loaded.merchantAccounts.get(String(purchase.merchant_account_id)) ?? null));
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const link = loaded.links.get(String(purchase.link_id))!;
  const id = String(purchase.id);
  const quantity = purchase.quantity ?? 1;
  const currency = String(purchase.displayed_price_currency_type);
  const gift = giftOf(purchase, loaded);
  const displayed = num(purchase.displayed_price_cents);
  const offerCode = purchase.offer_code_id == null ? null : (loaded.offerCodes.get(String(purchase.offer_code_id)) ?? null);
  const { discountCode, beforeOfferCode } = await offerCodeReading(purchase, offerCode, loaded.cachedDiscounts.has(id));
  const affiliate = purchase.affiliate_id == null ? undefined : loaded.affiliates.get(String(purchase.affiliate_id));
  const affiliateUser = affiliate ? loaded.affiliateUsers.get(String(affiliate.affiliate_user_id)) : undefined;
  const variant = loaded.variants.get(id);
  const tip = loaded.tips.get(id);
  const license = loaded.licenses.get(id);
  const review = loaded.reviews.get(id);
  const call = loaded.calls.get(id);
  const purchaser = purchase.purchaser_id == null ? null : (loaded.purchasers.get(String(purchase.purchaser_id)) ?? null);
  const ppp = flags("is_purchasing_power_parity_discounted") ? loaded.ppp.get(id) : undefined;
  const refunded = purchase.stripe_refunded === true || purchase.stripe_refunded === 1;
  const chargedBack = purchase.chargeback_date != null;
  const chargebackReversed = flags("chargeback_reversed");
  const accessRevoked = flags("is_access_revoked");
  const update = roleAdminFor(requireUser(sellerContext)) || roleSupportFor(requireUser(sellerContext));
  // Audience::PurchasePolicy#undo_revoke_access? / #revoke_access? (no refund, not physical, not a member: handed back above)
  const revokeAccess = update && !accessRevoked && !refunded && !LinkFlags.isSet(link.flags, "is_physical");
  const isAccessRevoked = accessRevoked ? (update ? true : null) : revokeAccess ? false : null;

  return {
    id: encrypt(purchase.id),
    email: purchase.email,
    giftee_email: gift?.giftee_email ?? null,
    is_gift_sender_purchase: flags("is_gift_sender_purchase"),
    is_gift_receiver_purchase: flags("is_gift_receiver_purchase"),
    name: present((purchase.full_name ?? "").trim()) ? purchase.full_name.trim() : (purchaser?.name ?? ""),
    physical: null,
    shipping: null,
    is_bundle_purchase: flags("is_bundle_purchase"),
    is_existing_user: purchaser !== null,
    can_contact: purchase.can_contact === true || purchase.can_contact === 1,
    product: { name: link.name, permalink: link.unique_permalink, native_type: link.native_type },
    created_at: iso(purchase.created_at),
    price: {
      cents: displayed,
      cents_before_offer_code: beforeOfferCode,
      cents_refundable: await refundableCents(purchase, loaded.refundedCents.get(id) ?? 0, currency),
      currency_type: currency,
      recurrence: null,
      tip_cents: tip ? num(tip.value_cents) : null,
    },
    quantity,
    discount: discountCode
      ? discountCode.amount_cents != null
        ? { type: "fixed", cents: discountCode.amount_cents, code: discountCode.code }
        : { type: "percent", percents: discountCode.amount_percentage, code: discountCode.code }
      : null,
    upsell: loaded.upsellNames.get(id) ?? null,
    subscription: null,
    is_multiseat_license: flags("is_multiseat_license"),
    referrer: displayReferrer(purchase, sellerUsername),
    is_additional_contribution: flags("is_additional_contribution"),
    ppp: ppp ? { country: purchase.ip_country, discount: `${Math.round((1 - num(ppp.factor)) * 100)}%` } : null,
    is_preorder: isPreorder(purchase, loaded.preorderIds),
    affiliate: affiliate && affiliateUser ? affiliateJson(purchase, affiliate, affiliateUser) : null,
    license: license
      ? {
          id: secureExternalId("License", license.id, LICENSE_SCOPE, { expiresAt: new Date(Date.now() + LICENSE_TTL_MS) }),
          key: license.serial,
          enabled: license.disabled_at == null,
          uses: license.uses,
        }
      : null,
    review: review
      ? { rating: review.rating, message: present(review.message) ? review.message : null, response: loaded.responses.has(String(review.id)) ? { message: loaded.responses.get(String(review.id))!.message } : null, videos: [] }
      : null,
    call: call ? { id: encrypt(call.id), call_url: call.call_url, start_time: iso(call.start_time), end_time: iso(call.end_time) } : null,
    commission: null,
    custom_fields: (loaded.customFields.get(id) ?? []).map((field) => ({
      attribute: present(loaded.fieldNames.get(String(field.custom_field_id))?.name) ? loaded.fieldNames.get(String(field.custom_field_id))!.name : field.name,
      type: "text",
      value: field.value == null ? "" : String(field.value),
    })),
    transaction_url_for_seller: null,
    is_access_revoked: isAccessRevoked,
    paypal_refund_expired: purchase.card_type === "paypal" && purchase.created_at.getTime() < Date.now() - 183 * 24 * 3600 * 1000,
    refunded,
    partially_refunded: purchase.stripe_partially_refunded === true || purchase.stripe_partially_refunded === 1,
    chargedback: chargedBack && !chargebackReversed && !refunded,
    has_options: variant !== undefined || loaded.hasAliveVariants.has(String(purchase.link_id)),
    option: variant === undefined ? null : variantOption(variant, link.name),
    utm_link: null,
    download_count: link.native_type === "coffee" ? null : (loaded.urlRedirects.get(id)?.uses ?? 0),
  };
}

// ---- the presenter ----

// UserPresenter#products_for_filter_box: visible products, an archived one only when it ever sold.
async function productsForFilterBox(seller: User) {
  const products = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL ORDER BY ${column("links", "id")} ASC`,
  );
  const shown: Row[] = [];
  for (const product of products) {
    if (LinkFlags.isSet(product.flags, "archived") && !(await hasSuccessfulSales(product.id))) continue;
    shown.push(product);
  }
  const productIds = shown.map((product) => product.id);
  const categories = productIds.length === 0 ? [] : await selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} IN (${inList(productIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL`);
  const categoryIds = categories.map((category) => category.id);
  const variants = categoryIds.length === 0 ? [] : await selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "variant_category_id")} IN (${inList(categoryIds)}) AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant'`);
  const skus = productIds.length === 0 ? [] : await selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "link_id")} IN (${inList(productIds)}) AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Sku' AND (${column("base_variants", "flags")} & 1 = 0)`);
  return shown.map((product) => {
    const physical = LinkFlags.isSet(product.flags, "is_physical");
    const first = categories.find((category) => Number(category.link_id) === Number(product.id));
    const options = physical ? skus.filter((sku) => Number(sku.link_id) === Number(product.id)) : first ? variants.filter((variant) => Number(variant.variant_category_id) === Number(first.id)) : [];
    return {
      id: encrypt(product.id),
      permalink: product.unique_permalink,
      name: product.name,
      variants: options.map((variant) => ({ id: encrypt(variant.id), name: variant.name || "" })),
    };
  });
}

// Link#has_successful_sales?: one search for the products that could be hidden.
async function hasSuccessfulSales(productId: bigint | number): Promise<boolean> {
  const result = await PurchaseSearchService.process({
    product: Number(productId),
    state: NON_GIFT_SUCCESS_STATES,
    exclude_refunded_except_subscriptions: true,
    exclude_unreversed_chargedback: true,
    exclude_non_original_subscription_purchases: true,
    exclude_deactivated_subscriptions: true,
    exclude_bundle_product_purchases: true,
    exclude_commission_completion_purchases: true,
    size: 0,
    track_total_hits: null,
  });
  return (result.total ?? 0) > 0;
}

// User#audience_types includes :customers: any audience member that is a customer.
const hasCustomerAudience = (sellerId: bigint) =>
  exists(Prisma.sql`SELECT 1 FROM ${table("audience_members")} WHERE ${column("audience_members", "seller_id")} = ${sellerId} AND ${column("audience_members", "customer")} = ${true} LIMIT 1`);

export async function customersProps(context: SellerContext, params: CustomersParams) {
  const seller = context.seller!;
  const product = await fetchProduct(params.linkId);
  const result = await fetchSales(seller, params, product);
  const total = result.total ?? 0;
  const loaded = await load(result.ids, seller);
  const sellerUsername = present(seller.username) ? seller.username : seller.external_id!;
  const customers = [];
  for (const purchase of loaded.purchases) customers.push(await customerJson(purchase, { seller, sellerUsername, sellerContext: context, loaded }));
  return {
    pagination: { page: params.paged ? pageOffset(params.page) / CUSTOMERS_PER_PAGE + 1 : 1, pages: totalPages(total), next: null },
    product_id: product ? encrypt(product.id) : null,
    customers,
    count: total,
    products: await productsForFilterBox(seller),
    currency_type: seller.currency_type,
    countries: COUNTRIES.filter((country) => !isBlockedCountry(country.alpha2) && country.alpha2 !== "SY")
      .map((country) => country.common_name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    can_ping: false,
    show_refund_fee_notice: !UserFlags.isSet(seller.flags, "refund_fee_notice_shown"),
    license_uses_filter_enabled: await isFeatureEnabled("license_uses_sales_filter", userActor(seller.id)),
    can_send_emails: await hasCustomerAudience(seller.id),
  };
}
