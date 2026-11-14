// CustomersController#index (`/customers`, `/customers/:link_id`): fetch_sales over PurchaseSearchService, CustomersPresenter
// and CustomerPresenter#customer (app/presenters/customer{,s}_presenter.rb).
//
// Handed back to Rails (HandBackToRails) when a customer on the page needs a reading the port does not make: a UTM link of another seller or with a post whose seller has no subdomain, a non-USD price without a
// stored rate or in a currency the port has no table for, a refund whose json_data is not plain JSON, a commission
// completion in progress that holds a Stripe processor reference, and a review video whose thumbnail variant Rails has not processed.
import { Prisma, type Purchase, type Subscription, type User } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { getConfig } from "../../infra/config.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { railsEnv, type RailsEnv } from "../../infra/rails-env.ts";
import { COUNTRIES, historicalNames, isBlockedCountry } from "../../models/compliance-countries.ts";
import { formattedDollarAmount, usdCentsToCurrency } from "../../models/concerns/currency-helper.ts";
import LINK_DATA from "../../models/link-data.generated.json" with { type: "json" };
import { LinkFlags } from "../../models/link.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "../../models/merchant-account.ts";
import { originalPrice } from "../../models/offer-code.ts";
import { canPingSales } from "../../models/ping-notification.ts";
import { variantContentPermitsLicenseKey } from "../../models/purchase-license-key.ts";
import { PurchaseRecord } from "../../models/purchase-pricing.ts";
import { secureExternalId } from "../../models/secure-external-id.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import {
  currentSubscriptionPriceCents,
  subscriptionRenewalPreDiscountTotalCents,
} from "../../models/subscription-pricing.ts";
import { defaultSubscriptionDeps, SubscriptionFlags, SubscriptionRecord } from "../../models/subscription.ts";
import { NotPortedError, UserFlags } from "../../models/user.ts";
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "../../policies/seller-context.ts";
import { variantToOption } from "../../presenters/product-props.ts";
import type { LinkRow, PriceRow } from "../../presenters/product-reads.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { extractDomain } from "../../search/referrer.ts";
import { targets as utmTargets, utmUrl, type UtmLinkRow } from "../audience/utm-links.ts";
import { NotPortedError as PageNotPortedError } from "../not-ported.ts";
import { videoFileThumbnailUrl } from "../signed-in/thumbnails.ts";

import { commissionFileDetails, customFieldFileDetails, type FileDetails } from "./file-details.ts";
import { physicalJson, shippingJson, shippingReading, skuOption, type ShippingReading } from "./shipping.ts";

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

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
export const num = (value: unknown): number => Number(value);
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
export const pageOffset = (page: string | undefined) =>
  Math.min(Math.max(rubyToI(page), 0), MAX_RESULT_WINDOW / CUSTOMERS_PER_PAGE - 1) * CUSTOMERS_PER_PAGE;
export const totalPages = (total: number) =>
  Math.min(Math.ceil(total / CUSTOMERS_PER_PAGE), MAX_RESULT_WINDOW / CUSTOMERS_PER_PAGE);

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

async function rowsBy(
  tableName: string,
  columnName: string,
  ids: unknown[],
  extra: Prisma.Sql = Prisma.empty,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  return selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${inList(ids)})${extra} ORDER BY ${column(tableName, "id")} ASC`,
  );
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
  // `shipping` of each purchase of a product that requires it, by purchase id.
  shippings: Map<string, ShippingReading>;
  // The alive prices of each tiered membership, for the `recurrence_price_values` of the tier a buyer picked.
  tierPrices: Map<string, Row[]>;
  // What CustomerPresenter reads off `purchase.subscription`, by subscription id.
  subscriptions: Map<string, SubscriptionReading>;
  // `purchase.price.recurrence` of a purchase with no subscription, by purchase id.
  priceRecurrences: Map<string, string | null>;
  // CustomerPresenter's `utm_link` hash, by purchase id.
  utmLinks: Map<string, Record<string, unknown>>;
  // `upsell_purchase&.upsell&.name`, by purchase id.
  upsellNames: Map<string, string | null>;
  affiliates: Map<string, Row>;
  affiliateUsers: Map<string, Row>;
  licenses: Map<string, Row>;
  reviews: Map<string, Row>;
  responses: Map<string, Row>;
  customFields: Map<string, Row[]>;
  fieldNames: Map<string, Row>;
  customFieldFiles: Map<string, FileDetails[]>;
  tips: Map<string, Row>;
  urlRedirects: Map<string, Row>;
  purchasers: Map<string, Row>;
  calls: Map<string, Row>;
  ppp: Map<string, Row>;
  merchantAccounts: Map<string, Row>;
  // Purchase#amount_refunded_cents: the sum of the effective refunds.
  refundedCents: Map<string, number>;
  gifts: Map<string, Row>;
  // The license a gift sender's giftee holds, by the sender's purchase id (the fallback of Purchase#linked_license).
  gifteeLicenses: Map<string, Row>;
  // The direct affiliate's part of `affiliate_credit_cents` (credits_direct_affiliate?), by purchase id.
  directAffiliateCredits: Map<string, number>;
  // The gift a receiver's purchase was delivered through (`gift_received`), by the receiver's purchase id.
  receivedGifts: Map<string, Row>;
  // The ids of the preorders the page's purchases belong to (`purchase.preorder.present?`).
  preorderIds: Set<string>;
  commissions: Map<string, CommissionReading>;
  // The alive pending and approved videos of each review, by review id, in the order CustomerPresenter lists them.
  reviewVideos: Map<string, Row[]>;
};

// Purchase#commission with what the presenter and the deposit row read off it. `completion` is the completion purchase
// when it is charged (`charged_commission_completion_purchase`).
export type CommissionReading = {
  id: string;
  status: string;
  filesAreEditable: boolean;
  files: FileDetails[];
  completion: { displayedCents: number; beforeOfferCode: number; tipCents: number | null } | null;
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
  const upsells = byId(
    await rowsBy("upsells", "id", [...new Set(upsellPurchases.map((upsellPurchase) => upsellPurchase.upsell_id))]),
  );
  return new Map(
    upsellPurchases.map(
      (upsellPurchase) =>
        [String(upsellPurchase.purchase_id), upsells.get(String(upsellPurchase.upsell_id))?.name ?? null] as const,
    ),
  );
}

// The shipping price and shipment of the purchases whose product requires shipping.
async function shippingReadings(purchases: Row[], links: Map<string, Row>): Promise<Map<string, ShippingReading>> {
  const shipped = purchases.filter((purchase) => links.get(String(purchase.link_id))!.require_shipping);
  const ids = shipped.map((purchase) => purchase.id);
  const prices = byId(
    await rowsBy("prices", "id", [...new Set(shipped.map((purchase) => purchase.price_id).filter((id) => id != null))]),
  );
  const shipments = groupBy(await rowsBy("shipments", "purchase_id", ids), "purchase_id");
  const subscriptionRows = byId(
    await rowsBy("subscriptions", "id", [
      ...new Set(shipped.map((purchase) => purchase.subscription_id).filter((id) => id != null)),
    ]),
  );
  const now = new Date();
  const knownRate = (currency: string) => currency in KNOWN_CURRENCIES;
  const readings = new Map<string, ShippingReading>();
  for (const purchase of shipped) {
    const own = shipments.get(String(purchase.id)) ?? [];
    const link = links.get(String(purchase.link_id))!;
    const plainRate = PLAIN_RATE.test(String(purchase.rate_converted_to_usd ?? "").trim());
    // Purchase#price_for_recurrence: the purchase's own price, else its subscription's last payment option's.
    let price = prices.get(String(purchase.price_id));
    const subscription =
      purchase.subscription_id == null ? undefined : subscriptionRows.get(String(purchase.subscription_id));
    if (price === undefined && subscription !== undefined) {
      const record = new SubscriptionRecord(castRow<Subscription>("Subscription", subscription), {
        now: () => now,
        featureActive: defaultSubscriptionDeps.featureActive,
      });
      try {
        price = ((await record.price()) as Row | null) ?? undefined;
      } catch (error) {
        if (error instanceof NotPortedError) throw new HandBackToRails();
        throw error;
      }
    }
    readings.set(
      String(purchase.id),
      await shippingReading(
        purchase,
        link,
        price,
        // `has_one :shipment` is `LIMIT 1` over index_shipments_on_purchase_id, so InnoDB yields the lowest id (rows come id ASC).
        own[0] ?? null,
        (currency) => knownRate(currency) && plainRate,
        subscription !== undefined && subscription.charge_occurrence_count === 1,
      ),
    );
  }
  return readings;
}

// CustomerPresenter#review_videos_props: the pending video, then the approved one, each with its file's `thumbnail_url`.
// A thumbnail whose variant Rails has not processed hands back.
export async function shownReviewVideos(reviewIds: unknown[]): Promise<Map<string, Row[]>> {
  const shown = new Map<string, Row[]>();
  const videos = await rowsBy(
    "product_review_videos",
    "product_review_id",
    reviewIds,
    Prisma.sql` AND ${column("product_review_videos", "deleted_at")} IS NULL AND ${column("product_review_videos", "approval_status")} IN ('pending_review', 'approved')`,
  );
  if (videos.length === 0) return shown;
  const files = groupBy(
    await rowsBy(
      "video_files",
      "record_id",
      videos.map((video) => video.id),
      Prisma.sql` AND ${column("video_files", "record_type")} = 'ProductReviewVideo'`,
    ),
    "record_id",
  );
  // `video.video_file` is a has_one with no order, and a video without one would raise in `thumbnail_url`.
  if (videos.some((video) => files.get(String(video.id))?.length !== 1)) throw new HandBackToRails();
  const thumbnails = new Map<string, string | null>();
  for (const file of [...files.values()].flat()) {
    try {
      thumbnails.set(String(file.record_id), await videoFileThumbnailUrl(file.id));
    } catch (error) {
      if (error instanceof PageNotPortedError) throw new HandBackToRails();
      throw error;
    }
  }
  for (const video of videos) video.thumbnail_url = thumbnails.get(String(video.id)) ?? null;
  const byReview = groupBy(videos, "product_review_id");
  for (const [reviewId, list] of byReview) {
    const pending = list.filter((video) => video.approval_status === "pending_review");
    const approved = list.filter((video) => video.approval_status === "approved");
    // At most one of each is guaranteed; more would make `find` order-dependent.
    if (pending.length > 1 || approved.length > 1) throw new HandBackToRails();
    shown.set(reviewId, [...pending, ...approved]);
  }
  return shown;
}

// Purchase#commission (the deposit's commission_as_deposit, the completion's commission_as_completion) and the completion
// purchase CustomerPresenter folds into a deposit row.
export async function commissionReadings(purchases: Row[]): Promise<Map<string, CommissionReading>> {
  const idsWith = (flag: "is_commission_deposit_purchase" | "is_commission_completion_purchase") =>
    purchases.filter((purchase) => PurchaseFlags.isSet(purchase.flags, flag)).map((purchase) => purchase.id);
  const asDeposit = await rowsBy("commissions", "deposit_purchase_id", idsWith("is_commission_deposit_purchase"));
  const asCompletion = await rowsBy(
    "commissions",
    "completion_purchase_id",
    idsWith("is_commission_completion_purchase"),
  );
  const rows = [...asDeposit, ...asCompletion];
  const readings = new Map<string, CommissionReading>();
  if (rows.length === 0) return readings;
  const files = await commissionFileDetails(rows.map((row) => row.id));

  const completions = byId(
    await rowsBy("purchases", "id", [
      ...new Set(asDeposit.map((row) => row.completion_purchase_id).filter((id) => id != null)),
    ]),
  );
  // An in_progress completion counts as charged only while it waits on processor settlement (pending_processor_settlement?),
  // which needs a Stripe charge processor and a processor reference. Without a reference (and no Charge), or on another
  // processor, it folds nowhere; a Stripe reference hands back (the rest reads Charge and flow of funds).
  const inProgress = [...completions.values()].filter((completion) => completion.purchase_state === "in_progress");
  if (inProgress.length > 0) {
    const withCharge = new Set(
      (
        await rowsBy(
          "charge_purchases",
          "purchase_id",
          inProgress.map((completion) => completion.id),
        )
      ).map((link) => String(link.purchase_id)),
    );
    const hasReference = (completion: Row) =>
      Boolean(completion.stripe_transaction_id) ||
      Boolean(completion.processor_payment_intent_id) ||
      withCharge.has(String(completion.id));
    if (inProgress.some((completion) => completion.charge_processor_id === "stripe" && hasReference(completion)))
      throw new HandBackToRails();
  }
  const charged = [...completions.values()].filter((completion) => completion.purchase_state === "successful");
  const chargedIds = charged.map((completion) => completion.id);
  const tips = new Map((await rowsBy("tips", "purchase_id", chargedIds)).map((tip) => [String(tip.purchase_id), tip]));
  const offerCodes = byId(
    await rowsBy("offer_codes", "id", [
      ...new Set(charged.map((completion) => completion.offer_code_id).filter((id) => id != null)),
    ]),
  );
  const cached = new Set(
    (await rowsBy("purchase_offer_code_discounts", "purchase_id", chargedIds)).map((discount) =>
      String(discount.purchase_id),
    ),
  );

  const reading = (row: Row) => ({
    id: encrypt(row.id),
    status: row.status as string,
    filesAreEditable: row.status !== "completed" && row.completion_purchase_id == null,
    files: files.get(String(row.id)) ?? [],
  });
  // The completion row shows the commission but is not folded into anything.
  for (const row of asCompletion)
    readings.set(String(row.completion_purchase_id), { ...reading(row), completion: null });
  for (const row of asDeposit) {
    const completion = completions.get(String(row.completion_purchase_id));
    const base = reading(row);
    const key = String(row.deposit_purchase_id);
    if (completion === undefined || completion.purchase_state !== "successful") {
      readings.set(key, { ...base, completion: null });
      continue;
    }
    const offerCode =
      completion.offer_code_id == null ? null : (offerCodes.get(String(completion.offer_code_id)) ?? null);
    const { beforeOfferCode } = await offerCodeReading(completion, offerCode, cached.has(String(completion.id)));
    const tip = tips.get(String(completion.id));
    readings.set(key, {
      ...base,
      completion: {
        displayedCents: num(completion.displayed_price_cents),
        beforeOfferCode,
        tipCents: tip ? num(tip.value_cents) : null,
      },
    });
  }
  return readings;
}

// `purchase.utm_link` (has_one through utm_link_driven_sale) as CustomerPresenter renders it.
export async function utmLinkReadings(
  purchaseIds: unknown[],
  seller: User,
): Promise<Map<string, Record<string, unknown>>> {
  const driven = await rowsBy("utm_link_driven_sales", "purchase_id", purchaseIds);
  // has_one picks an arbitrary row when a purchase was driven by several visits.
  if (new Set(driven.map((sale) => String(sale.purchase_id))).size !== driven.length) throw new HandBackToRails();
  const linkRows = byId(await rowsBy("utm_links", "id", [...new Set(driven.map((sale) => sale.utm_link_id))]));
  if (driven.some((sale) => !linkRows.has(String(sale.utm_link_id)))) throw new HandBackToRails();
  const links = [...linkRows.values()] as unknown as UtmLinkRow[];
  if (links.some((link) => String(link.seller_id) !== String(seller.id))) throw new HandBackToRails();
  const resolved = await utmTargets(links);
  const readings = new Map<string, Record<string, unknown>>();
  for (const sale of driven) {
    const link = linkRows.get(String(sale.utm_link_id)) as unknown as UtmLinkRow;
    let url: string | null;
    try {
      url = utmUrl(seller, link, resolved);
    } catch (error) {
      // A post whose seller has no subdomain: Installment#full_url is Rails' to answer.
      if (error instanceof Error && error.name === "NotPortedError") throw new HandBackToRails();
      throw error;
    }
    readings.set(String(sale.purchase_id), {
      title: link.title,
      utm_url: url,
      source: link.utm_source,
      medium: link.utm_medium,
      campaign: link.utm_campaign,
      term: link.utm_term,
      content: link.utm_content,
    });
  }
  return readings;
}

// usd_cents_to_currency converts the refundable amount at the rate stored on the sale; without one it would ask Redis.
export function assertRefundableReadable(purchase: Row): void {
  if (
    purchase.displayed_price_currency_type !== "usd" &&
    !(
      typeof purchase.displayed_price_currency_type === "string" &&
      purchase.displayed_price_currency_type in KNOWN_CURRENCIES &&
      PLAIN_RATE.test(String(purchase.rate_converted_to_usd ?? "").trim())
    )
  )
    throw new HandBackToRails();
}

// Purchase#amount_refunded_cents: the sum of the effective refunds, by purchase id.
export async function refundedCentsOf(purchaseIds: unknown[]): Promise<Map<string, number>> {
  const refundedCents = new Map<string, number>();
  for (const refund of await rowsBy("refunds", "purchase_id", purchaseIds)) {
    if (!refundIsEffective(refund)) continue;
    const key = String(refund.purchase_id);
    refundedCents.set(key, (refundedCents.get(key) ?? 0) + num(refund.amount_cents ?? 0));
  }
  return refundedCents;
}

type VariantOrder = "join" | "id";

// Purchase.where(id: ids).in_order_of(:id, ids) with the associations CustomerPresenter reads, after handing back what it cannot.
async function load(ids: string[], seller: User, variantOrder: VariantOrder = "join"): Promise<Loaded> {
  const rows = await rowsBy("purchases", "id", ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  const purchases = rows.sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);
  const purchaseIds = purchases.map((purchase) => purchase.id);

  const links = byId(await rowsBy("links", "id", [...new Set(purchases.map((purchase) => purchase.link_id))]));
  for (const purchase of purchases) assertRefundableReadable(purchase);
  const commissions = await commissionReadings(purchases);

  const affiliates = byId(
    await rowsBy("affiliates", "id", [
      ...new Set(purchases.map((purchase) => purchase.affiliate_id).filter((id) => id != null)),
    ]),
  );
  const affiliateUsers = byId(
    await rowsBy("users", "id", [
      ...new Set([...affiliates.values()].map((affiliate) => affiliate.affiliate_user_id).filter((id) => id != null)),
    ]),
  );
  // `purchase.affiliate.affiliate_user` raises for an affiliate without a user, which is Rails' to answer.
  if ([...affiliates.values()].some((affiliate) => !affiliateUsers.has(String(affiliate.affiliate_user_id))))
    throw new HandBackToRails();

  const directAffiliateCredits = await directCreditsOf(purchases, affiliates);

  // A sale of several options shows the first of `variant_attributes`: the preload assembles it in the order of the join rows, while
  // `.first` on an association that was not preloaded reads the lowest variant id.
  const joinRows = (await rowsBy("base_variants_purchases", "purchase_id", purchaseIds)).sort((a, b) =>
    variantOrder === "join" ? num(a.id) - num(b.id) : num(a.base_variant_id) - num(b.base_variant_id),
  );
  const picks = groupBy(joinRows, "purchase_id");
  const variantRows = byId(
    await rowsBy("base_variants", "id", [...new Set([...picks.values()].flat().map((pick) => pick.base_variant_id))]),
  );
  const variants = new Map(
    [...picks]
      .map(([purchaseId, [pick]]) => [purchaseId, variantRows.get(String(pick!.base_variant_id))] as const)
      .filter((entry): entry is [string, Row] => entry[1] !== undefined),
  );
  if (variants.size !== picks.size) throw new HandBackToRails();
  for (const variant of variants.values())
    if (variant.type !== "Variant" && variant.type !== "Sku") throw new HandBackToRails();
  const shippings = await shippingReadings(purchases, links);
  const tieredLinkIds = [...links.values()]
    .filter((link) => LinkFlags.isSet(link.flags, "is_tiered_membership"))
    .map((link) => link.id);
  const tierPrices = groupBy(
    await rowsBy("prices", "link_id", tieredLinkIds, Prisma.sql` AND ${column("prices", "deleted_at")} IS NULL`),
    "link_id",
  );
  const subscriptions = await subscriptionReadings(purchases);
  const subscriptionless = purchases.filter(
    (purchase) => purchase.price_id != null && !subscriptions.has(String(purchase.subscription_id)),
  );
  const priceRecurrences = new Map(
    (await rowsBy("prices", "id", [...new Set(subscriptionless.map((purchase) => purchase.price_id))])).flatMap(
      (price) =>
        subscriptionless
          .filter((purchase) => String(purchase.price_id) === String(price.id))
          .map(
            (purchase) => [String(purchase.id), price.recurrence == null ? null : String(price.recurrence)] as const,
          ),
    ),
  );
  const upsellNames = await upsellNamesFor(purchaseIds);
  const utmLinks = await utmLinkReadings(purchaseIds, seller);

  const refundedCents = await refundedCentsOf(purchaseIds);

  const senderIds = purchases
    .filter((purchase) => PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase"))
    .map((purchase) => purchase.id);
  const gifts = new Map(
    (await rowsBy("gifts", "gifter_purchase_id", senderIds)).map((gift) => [String(gift.gifter_purchase_id), gift]),
  );
  const receiverIds = purchases
    .filter((purchase) => PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase"))
    .map((purchase) => purchase.id);
  const receivedGifts = new Map(
    (await rowsBy("gifts", "giftee_purchase_id", receiverIds)).map((gift) => [String(gift.giftee_purchase_id), gift]),
  );
  const gifteeLicenses = await gifteeLicensesOf(gifts);

  // CustomerPresenter reads Purchase#alive_original_product_review.
  const reviews = byId(
    await rowsBy(
      "product_reviews",
      "purchase_id",
      purchaseIds,
      Prisma.sql` AND ${column("product_reviews", "deleted_at")} IS NULL`,
    ),
  );
  const reviewsByPurchase = new Map([...reviews.values()].map((review) => [String(review.purchase_id), review]));
  const reviewIds = [...reviews.values()].map((review) => review.id);
  const reviewVideos = await shownReviewVideos(reviewIds);
  const responses = new Map(
    (await rowsBy("product_review_responses", "product_review_id", reviewIds)).map((response) => [
      String(response.product_review_id),
      response,
    ]),
  );

  const customFields = groupBy(await rowsBy("purchase_custom_fields", "purchase_id", purchaseIds), "purchase_id");
  const fieldRows = [...customFields.values()].flat();
  const customFieldFiles = await customFieldFileDetails(
    fieldRows.filter((field) => field.field_type === "file").map((field) => field.id),
  );
  const fieldNames = byId(
    await rowsBy("custom_fields", "id", [
      ...new Set(fieldRows.map((field) => field.custom_field_id).filter((id) => id != null)),
    ]),
  );

  return {
    purchases,
    commissions,
    reviewVideos,
    links,
    hasAliveVariants: await productsWithAliveVariants([...links.keys()]),
    receivedGifts,
    gifteeLicenses,
    directAffiliateCredits,
    preorderIds: new Set(
      (
        await rowsBy("preorders", "id", [
          ...new Set(purchases.map((purchase) => purchase.preorder_id).filter((id) => id != null)),
        ])
      ).map((preorder) => String(preorder.id)),
    ),
    variants,
    shippings,
    tierPrices,
    subscriptions,
    priceRecurrences,
    upsellNames,
    utmLinks,
    affiliates,
    affiliateUsers,
    cachedDiscounts: new Set(
      (await rowsBy("purchase_offer_code_discounts", "purchase_id", purchaseIds)).map((discount) =>
        String(discount.purchase_id),
      ),
    ),
    offerCodes: byId(
      await rowsBy("offer_codes", "id", [
        ...new Set(purchases.map((purchase) => purchase.offer_code_id).filter((id) => id != null)),
      ]),
    ),
    licenses: new Map(
      (
        await rowsBy(
          "licenses",
          "purchase_id",
          purchaseIds,
          Prisma.sql` AND ${column("licenses", "deleted_at")} IS NULL`,
        )
      ).map((license) => [String(license.purchase_id), license]),
    ),
    reviews: reviewsByPurchase,
    responses,
    customFields,
    fieldNames,
    customFieldFiles,
    tips: new Map((await rowsBy("tips", "purchase_id", purchaseIds)).map((tip) => [String(tip.purchase_id), tip])),
    urlRedirects: new Map(
      (await rowsBy("url_redirects", "purchase_id", purchaseIds)).map((redirect) => [
        String(redirect.purchase_id),
        redirect,
      ]),
    ),
    purchasers: byId(
      await rowsBy("users", "id", [
        ...new Set(purchases.map((purchase) => purchase.purchaser_id).filter((id) => id != null)),
      ]),
    ),
    calls: new Map((await rowsBy("calls", "purchase_id", purchaseIds)).map((call) => [String(call.purchase_id), call])),
    merchantAccounts: byId(
      await rowsBy("merchant_accounts", "id", [
        ...new Set(purchases.map((purchase) => purchase.merchant_account_id).filter((id) => id != null)),
      ]),
    ),
    refundedCents,
    gifts,
    ppp: new Map(
      (await rowsBy("purchasing_power_parity_infos", "purchase_id", purchaseIds)).map((info) => [
        String(info.purchase_id),
        info,
      ]),
    ),
  };
}

// Ruby's `Integer#to_i` on a json_data cell: nil is 0, and a value the port cannot read as a number is Rails' to answer.
function jsonInteger(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  throw new HandBackToRails();
}

// credits_direct_affiliate?: a collaborator sale that also credits a DirectAffiliate holds both credits in `affiliate_credit_cents`,
// and `own_affiliate_credit_cents` takes the direct affiliate's part (json_data `direct_affiliate_credit_cents`) off.
export async function directCreditsOf(purchases: Row[], affiliates: Map<string, Row>): Promise<Map<string, number>> {
  const candidates = new Map<string, { directId: unknown; credit: number }>();
  for (const purchase of purchases) {
    if (purchase.affiliate_id == null || affiliates.get(String(purchase.affiliate_id))?.type !== "Collaborator")
      continue;
    if (typeof purchase.json_data !== "string" || !purchase.json_data.includes("direct_affiliate_id")) continue;
    let data: unknown;
    try {
      data = JSON.parse(purchase.json_data);
    } catch {
      throw new HandBackToRails();
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new HandBackToRails();
    const fields = data as Record<string, unknown>;
    // `direct_affiliate_id.present?`
    if (fields.direct_affiliate_id == null || fields.direct_affiliate_id === "") continue;
    candidates.set(String(purchase.id), {
      directId: fields.direct_affiliate_id,
      credit: jsonInteger(fields.direct_affiliate_credit_cents),
    });
  }
  if (candidates.size === 0) return new Map();
  const direct = new Set(
    (await rowsBy("affiliates", "id", [...new Set([...candidates.values()].map((candidate) => candidate.directId))]))
      .filter((affiliate) => affiliate.type === "DirectAffiliate")
      .map((affiliate) => String(affiliate.id)),
  );
  return new Map(
    [...candidates]
      .filter(([, candidate]) => direct.has(String(candidate.directId)))
      .map(([id, { credit }]) => [id, credit]),
  );
}

// Purchase#linked_license of a gift sender with no key of its own: the license of the giftee's purchase, when that purchase uses a
// license key (`uses_license_key?`).
export async function gifteeLicensesOf(gifts: Map<string, Row>): Promise<Map<string, Row>> {
  const gifteeIds = [...gifts.values()].map((gift) => gift.giftee_purchase_id).filter((id) => id != null);
  if (gifteeIds.length === 0) return new Map();
  const licenses = new Map(
    (
      await rowsBy("licenses", "purchase_id", gifteeIds, Prisma.sql` AND ${column("licenses", "deleted_at")} IS NULL`)
    ).map((license) => [String(license.purchase_id), license]),
  );
  if (licenses.size === 0) return new Map();
  const gifteePurchases = byId(await rowsBy("purchases", "id", [...licenses.keys()]));
  const products = byId(
    await rowsBy("links", "id", [...new Set([...gifteePurchases.values()].map((purchase) => purchase.link_id))]),
  );
  const result = new Map<string, Row>();
  for (const [senderId, gift] of gifts) {
    const license = licenses.get(String(gift.giftee_purchase_id));
    const giftee = gifteePurchases.get(String(gift.giftee_purchase_id));
    const product = giftee && products.get(String(giftee.link_id));
    if (!license || !product || !LinkFlags.isSet(product.flags, "is_licensed")) continue;
    if (!(await variantContentPermitsLicenseKey(giftee, product))) continue;
    if (license.serial != null && license.serial !== "") result.set(senderId, license);
  }
  return result;
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

// Purchase#transaction_url_for_seller: nil unless the sale was charged outside Gumroad's own Stripe account, else the processor's
// dashboard page for the charge. Braintree's embeds the merchant id from GlobalConfig.
export function transactionUrlForSeller(
  purchase: Row,
  merchantAccount: Row | null,
  env: RailsEnv = railsEnv(),
): string | null {
  if (!present(purchase.charge_processor_id) || !present(purchase.stripe_transaction_id)) return null;
  // Purchase#charged_using_gumroad_merchant_account?
  const gumroadAccount = merchantAccount !== null && merchantAccount.user_id == null;
  const stripeWithoutConnect =
    purchase.charge_processor_id === "stripe" &&
    !(merchantAccount !== null && isStripeConnectAccount(merchantAccount as MerchantAccountRow));
  if (gumroadAccount || stripeWithoutConnect) return null;

  const production = env === "production";
  const chargeId = purchase.stripe_transaction_id;
  if (purchase.charge_processor_id === "stripe")
    return `https://manage.stripe.com/${production ? "" : "test/"}payments/${chargeId}`;
  if (purchase.charge_processor_id === "paypal") {
    return `https://${production ? "history" : "sandbox"}.paypal.com/us/cgi-bin/webscr?cmd=_history-details-from-hub&id=${chargeId}`;
  }
  if (purchase.charge_processor_id === "braintree") {
    return `https://${production ? "www" : "sandbox"}.braintreegateway.com/merchants/${getConfig("BRAINTREE_MERCHANT_ID") ?? ""}/transactions/${chargeId}`;
  }
  throw new HandBackToRails();
}

// Purchase#amount_refundable_cents_in_currency
export function refundableCents(purchase: Row, refundedCents: number, currency: string): Promise<number> {
  const refundable = CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id)
    ? num(purchase.price_cents) - refundedCents
    : 0;
  return usdCentsToCurrency(
    currency,
    refundable,
    currency === "usd" ? undefined : Number(String(purchase.rate_converted_to_usd).trim()),
  );
}

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

type ShownCode = { amount_cents: number | null; amount_percentage: number | null; code: string | null };

// CustomerPresenter's `discount` (Purchase#original_offer_code) and `cents_before_offer_code`
// (Purchase#displayed_price_cents_before_offer_code(include_deleted: true)).
export async function offerCodeReading(
  purchase: Row,
  offerCode: Row | null,
  cached: boolean,
): Promise<{ discountCode: ShownCode | null; beforeOfferCode: number }> {
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
      discountCode:
        shown && cachedCode !== undefined
          ? { amount_cents: shown.amount_cents, amount_percentage: shown.amount_percentage, code: cachedCode }
          : null,
      beforeOfferCode: (await record.displayedPriceCentsBeforeOfferCode(true)) ?? displayed,
    };
  }
  const discountCode = offerCode && !deleted ? (offerCode as ShownCode) : null;
  if (!offerCode) return { discountCode, beforeOfferCode: displayed };
  const price = originalPrice(
    { amount_cents: offerCode.amount_cents, amount_percentage: offerCode.amount_percentage },
    displayed,
  );
  return { discountCode, beforeOfferCode: price === null ? displayed : price * quantity };
}

export type SubscriptionReading = {
  id: string;
  status: string | null;
  isInstallmentPlan: boolean;
  remainingCharges: number | null;
  recurrence: string | null;
  // Subscription#current_subscription_price_cents, null when it has none.
  currentPriceCents: number | null;
};

// `(purchase.subscription || purchase.price)&.recurrence`
export function recurrenceOf(
  subscription: Pick<SubscriptionReading, "recurrence"> | undefined,
  priceRecurrence: string | null | undefined,
): string | null {
  return (subscription ? subscription.recurrence : priceRecurrence) ?? null;
}

// Subscription#status. `lastPurchaseState` is the state of the subscription's newest purchase; `paymentMethodUpdateRequired` is the
// Indian card mandate branch (renewals disabled, reliability enabled and a charge still ahead), which only matters once the rest says alive.
export function subscriptionStatus(
  subscription: Row,
  lastPurchaseState: string | null,
  now: Date,
  paymentMethodUpdateRequired = false,
): string | null {
  if (subscription.deactivated_at != null) {
    if (subscription.failed_at != null) return "failed_payment";
    if (subscription.ended_at != null) return "fixed_subscription_period_ended";
    return subscription.cancelled_at != null ? "cancelled" : null;
  }
  const alive =
    subscription.failed_at == null &&
    subscription.ended_at == null &&
    (subscription.cancelled_at == null || subscription.cancelled_at.getTime() > now.getTime());
  if (alive && lastPurchaseState === "failed") return "pending_failure";
  if (alive && subscription.cancelled_at != null) return "pending_cancellation";
  return paymentMethodUpdateRequired ? "payment_method_update_required" : "alive";
}

// Subscription#future_subscription_charge?. `preDiscountCents` is `renewal_pre_discount_total_cents`, read only for a
// free renewal under a limited-cycle discount.
export async function futureSubscriptionCharge(
  chargesCompleted: boolean,
  currentPriceCents: number | null,
  limitedCycleDiscount: boolean,
  preDiscountCents: () => Promise<number | null>,
): Promise<boolean> {
  if (chargesCompleted) return false;
  if (currentPriceCents !== null && currentPriceCents > 0) return true;
  if (!limitedCycleDiscount) return false;
  const preDiscount = await preDiscountCents();
  // nil.positive? raises in Rails
  if (preDiscount === null) throw new HandBackToRails();
  return preDiscount > 0;
}

async function subscriptionReadings(purchases: Row[]): Promise<Map<string, SubscriptionReading>> {
  const rows = await rowsBy("subscriptions", "id", [
    ...new Set(purchases.map((purchase) => purchase.subscription_id).filter((id) => id != null)),
  ]);
  if (rows.length === 0) return new Map();
  const now = new Date();
  const newest = new Map<string, string>();
  for (const purchase of await selectRows<Row>(
    Prisma.sql`SELECT ${column("purchases", "subscription_id")}, ${column("purchases", "purchase_state")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} IN (${inList(rows.map((row) => row.id))}) ORDER BY ${column("purchases", "created_at")} ASC, ${column("purchases", "id")} ASC`,
  )) {
    newest.set(String(purchase.subscription_id), purchase.purchase_state);
  }
  const readings = new Map<string, SubscriptionReading>();
  for (const row of rows) {
    const record = new SubscriptionRecord(castRow<Subscription>("Subscription", row), {
      now: () => now,
      featureActive: defaultSubscriptionDeps.featureActive,
    });
    try {
      const currentPriceCents = await currentSubscriptionPriceCents(record);
      const status = subscriptionStatus(row, newest.get(String(row.id)) ?? null, now);
      readings.set(String(row.id), {
        id: encrypt(row.id),
        status:
          status === "alive" &&
          SubscriptionFlags.isSet(row.flags, "renewal_disabled_due_to_indian_card_mandate") &&
          (await record.indiaCardMandateReliabilityEnabled()) &&
          (await mandateChargeAhead(record, currentPriceCents))
            ? "payment_method_update_required"
            : status,
        isInstallmentPlan: record.flag("is_installment_plan"),
        remainingCharges: record.hasFixedLength()
          ? num(row.charge_occurrence_count) - (await record.successfulPurchasesCount())
          : null,
        recurrence: await record.recurrence(),
        currentPriceCents,
      });
    } catch (error) {
      // A reading the port does not make (an auto-renewal code it cannot price, a subscription with no original purchase).
      if (error instanceof NotPortedError) throw new HandBackToRails();
      throw error;
    }
  }
  return readings;
}

// `original_purchase.nil? || future_subscription_charge?`
async function mandateChargeAhead(record: SubscriptionRecord, currentPriceCents: number | null): Promise<boolean> {
  const original = await record.originalPurchase();
  if (original === null) return true;
  const discounts = await rowsBy("purchase_offer_code_discounts", "purchase_id", [original.id]);
  return futureSubscriptionCharge(
    await record.chargesCompleted(),
    currentPriceCents,
    discounts.some((discount) => discount.duration_in_months != null),
    () => subscriptionRenewalPreDiscountTotalCents(record),
  );
}

// CustomerPresenter's `is_preorder`: the authorization of a preorder that still exists, not the purchase it was later charged as.
export function isPreorder(purchase: Row, preorderIds: Set<string>): boolean {
  return (
    purchase.preorder_id != null &&
    preorderIds.has(String(purchase.preorder_id)) &&
    PurchaseFlags.isSet(purchase.flags, "is_preorder_authorization")
  );
}

// Purchase#gift: the sender's gift_given, else the receiver's gift_received.
export function giftOf(purchase: Row, loaded: Pick<Loaded, "gifts" | "receivedGifts">): Row | undefined {
  const id = String(purchase.id);
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")) return loaded.gifts.get(id);
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")) return loaded.receivedGifts.get(id);
  return undefined;
}

// CustomerPresenter's `affiliate`: the affiliate's form_email, the credit this sale paid them (own_affiliate_credit_cents) and the STI type.
export function affiliateJson(purchase: Row, affiliate: Row, user: Row, directCreditCents = 0) {
  return {
    email: present(user.unconfirmed_email) ? user.unconfirmed_email : present(user.email) ? user.email : null,
    amount: formattedDollarAmount(num(purchase.affiliate_credit_cents ?? 0) - directCreditCents),
    type: affiliate.type,
  };
}

type Context = { seller: User; sellerUsername: string; sellerContext: SellerContext; loaded: Loaded };

async function customerJson(purchase: Row, { sellerUsername, sellerContext, loaded }: Context) {
  const transactionUrl = transactionUrlForSeller(
    purchase,
    purchase.merchant_account_id == null
      ? null
      : (loaded.merchantAccounts.get(String(purchase.merchant_account_id)) ?? null),
  );
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const link = loaded.links.get(String(purchase.link_id))!;
  const id = String(purchase.id);
  const quantity = purchase.quantity ?? 1;
  const currency = String(purchase.displayed_price_currency_type);
  const gift = giftOf(purchase, loaded);
  const displayed = num(purchase.displayed_price_cents);
  const offerCode =
    purchase.offer_code_id == null ? null : (loaded.offerCodes.get(String(purchase.offer_code_id)) ?? null);
  const { discountCode, beforeOfferCode } = await offerCodeReading(purchase, offerCode, loaded.cachedDiscounts.has(id));
  const affiliate = purchase.affiliate_id == null ? undefined : loaded.affiliates.get(String(purchase.affiliate_id));
  const affiliateUser = affiliate ? loaded.affiliateUsers.get(String(affiliate.affiliate_user_id)) : undefined;
  const variant = loaded.variants.get(id);
  const subscription =
    purchase.subscription_id == null ? undefined : loaded.subscriptions.get(String(purchase.subscription_id));
  const tip = loaded.tips.get(id);
  const ownLicense = loaded.licenses.get(id);
  const license = ownLicense && present(ownLicense.serial) ? ownLicense : (loaded.gifteeLicenses.get(id) ?? ownLicense);
  const commission = loaded.commissions.get(id);
  const completion = commission?.completion ?? null;
  const review = loaded.reviews.get(id);
  const call = loaded.calls.get(id);
  const purchaser =
    purchase.purchaser_id == null ? null : (loaded.purchasers.get(String(purchase.purchaser_id)) ?? null);
  const ppp = flags("is_purchasing_power_parity_discounted") ? loaded.ppp.get(id) : undefined;
  const refunded = purchase.stripe_refunded === true || purchase.stripe_refunded === 1;
  const chargedBack = purchase.chargeback_date != null;
  const chargebackReversed = flags("chargeback_reversed");
  const accessRevoked = flags("is_access_revoked");
  const update = roleAdminFor(requireUser(sellerContext)) || roleSupportFor(requireUser(sellerContext));
  // Audience::PurchasePolicy#undo_revoke_access? / #revoke_access? (no refund, not physical, not a member)
  const revokeAccess =
    update && !accessRevoked && !refunded && !LinkFlags.isSet(link.flags, "is_physical") && subscription === undefined;
  const isAccessRevoked = accessRevoked ? (update ? true : null) : revokeAccess ? false : null;

  return {
    id: encrypt(purchase.id),
    email: purchase.email,
    giftee_email: gift?.giftee_email ?? null,
    is_gift_sender_purchase: flags("is_gift_sender_purchase"),
    is_gift_receiver_purchase: flags("is_gift_receiver_purchase"),
    name: present((purchase.full_name ?? "").trim()) ? purchase.full_name.trim() : (purchaser?.name ?? ""),
    physical: variant?.type === "Sku" ? physicalJson(purchase, variant) : null,
    shipping: link.require_shipping
      ? shippingJson(purchase, loaded.shippings.get(id)!, LinkFlags.isSet(link.flags, "is_physical"))
      : null,
    is_bundle_purchase: flags("is_bundle_purchase"),
    is_existing_user: purchaser !== null,
    can_contact: purchase.can_contact === true || purchase.can_contact === 1,
    product: { name: link.name, permalink: link.unique_permalink, native_type: link.native_type },
    created_at: iso(purchase.created_at),
    price: {
      // listed_price_cents: a member is listed at what their next charge will be.
      cents: (subscription?.currentPriceCents ?? displayed) + (completion?.displayedCents ?? 0),
      cents_before_offer_code: completion ? beforeOfferCode + completion.beforeOfferCode : beforeOfferCode,
      cents_refundable: await refundableCents(purchase, loaded.refundedCents.get(id) ?? 0, currency),
      currency_type: currency,
      recurrence: recurrenceOf(subscription, loaded.priceRecurrences.get(id)),
      // listed_tip_cents: the deposit's tip, plus the completion's when it has one.
      tip_cents:
        completion?.tipCents == null
          ? tip
            ? num(tip.value_cents)
            : null
          : (tip ? num(tip.value_cents) : 0) + completion.tipCents,
    },
    quantity,
    discount: discountCode
      ? discountCode.amount_cents != null
        ? { type: "fixed", cents: discountCode.amount_cents, code: discountCode.code }
        : { type: "percent", percents: discountCode.amount_percentage, code: discountCode.code }
      : null,
    upsell: loaded.upsellNames.get(id) ?? null,
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          is_installment_plan: subscription.isInstallmentPlan,
          remaining_charges: subscription.remainingCharges,
        }
      : null,
    is_multiseat_license: flags("is_multiseat_license"),
    referrer: displayReferrer(purchase, sellerUsername),
    is_additional_contribution: flags("is_additional_contribution"),
    ppp: ppp ? { country: purchase.ip_country, discount: `${Math.round((1 - num(ppp.factor)) * 100)}%` } : null,
    is_preorder: isPreorder(purchase, loaded.preorderIds),
    affiliate:
      affiliate && affiliateUser
        ? affiliateJson(purchase, affiliate, affiliateUser, loaded.directAffiliateCredits.get(id))
        : null,
    license: license
      ? {
          id: secureExternalId("License", license.id, LICENSE_SCOPE, {
            expiresAt: new Date(Date.now() + LICENSE_TTL_MS),
          }),
          key: license.serial,
          enabled: license.disabled_at == null,
          uses: license.uses,
        }
      : null,
    review: review
      ? {
          rating: review.rating,
          message: present(review.message) ? review.message : null,
          response: loaded.responses.has(String(review.id))
            ? { message: loaded.responses.get(String(review.id))!.message }
            : null,
          videos: (loaded.reviewVideos.get(String(review.id)) ?? []).map((video) => ({
            id: encrypt(video.id),
            approval_status: video.approval_status,
            thumbnail_url: video.thumbnail_url ?? null,
            can_approve: update,
            can_reject: update,
          })),
        }
      : null,
    call: call
      ? {
          id: encrypt(call.id),
          call_url: call.call_url,
          start_time: iso(call.start_time),
          end_time: iso(call.end_time),
        }
      : null,
    commission: commission
      ? {
          id: commission.id,
          files: commission.files,
          status: commission.status,
          files_are_editable: commission.filesAreEditable,
        }
      : null,
    custom_fields: (loaded.customFields.get(id) ?? []).map((field) => {
      const attribute = present(loaded.fieldNames.get(String(field.custom_field_id))?.name)
        ? loaded.fieldNames.get(String(field.custom_field_id))!.name
        : field.name;
      if (field.field_type === "file")
        return { attribute, type: "file", files: loaded.customFieldFiles.get(String(field.id)) ?? [] };
      return { attribute, type: "text", value: field.value == null ? "" : String(field.value) };
    }),
    transaction_url_for_seller: transactionUrl,
    is_access_revoked: isAccessRevoked,
    paypal_refund_expired:
      purchase.card_type === "paypal" && purchase.created_at.getTime() < Date.now() - 183 * 24 * 3600 * 1000,
    refunded,
    partially_refunded: purchase.stripe_partially_refunded === true || purchase.stripe_partially_refunded === 1,
    chargedback: chargedBack && !chargebackReversed && !refunded,
    has_options: variant !== undefined || loaded.hasAliveVariants.has(String(purchase.link_id)),
    option:
      variant === undefined
        ? null
        : variant.type === "Sku"
          ? skuOption(variant)
          : await variantToOption(
              link as LinkRow,
              variant as never,
              (loaded.tierPrices.get(String(link.id)) ?? []) as PriceRow[],
              BigInt(link.user_id),
            ),
    utm_link: loaded.utmLinks.get(id) ?? null,
    download_count:
      flags("is_bundle_purchase") || link.native_type === "coffee" ? null : (loaded.urlRedirects.get(id)?.uses ?? 0),
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
  const categories =
    productIds.length === 0
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} IN (${inList(productIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL`,
        );
  const categoryIds = categories.map((category) => category.id);
  const variants =
    categoryIds.length === 0
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "variant_category_id")} IN (${inList(categoryIds)}) AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant'`,
        );
  const skus =
    productIds.length === 0
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "link_id")} IN (${inList(productIds)}) AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Sku' AND (${column("base_variants", "flags")} & 1 = 0)`,
        );
  return shown.map((product) => {
    const physical = LinkFlags.isSet(product.flags, "is_physical");
    const first = categories.find((category) => Number(category.link_id) === Number(product.id));
    const options = physical
      ? skus.filter((sku) => Number(sku.link_id) === Number(product.id))
      : first
        ? variants.filter((variant) => Number(variant.variant_category_id) === Number(first.id))
        : [];
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
export const hasCustomerAudience = (sellerId: bigint) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("audience_members")} WHERE ${column("audience_members", "seller_id")} = ${sellerId} AND ${column("audience_members", "customer")} = ${true} LIMIT 1`,
  );

// Compliance::Countries.for_select.map(&:last)
export const countryNames = () =>
  COUNTRIES.filter((country) => !isBlockedCountry(country.alpha2) && country.alpha2 !== "SY")
    .map((country) => country.common_name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// `CustomerPresenter.new(purchase:).customer(pundit_user:)` for purchases that did not come out of the sales search.
// `variantOrder: "id"` is for a caller whose purchase is fetched without the preload (mobile sales#show).
export async function customersOfPurchases(context: SellerContext, ids: string[], variantOrder: VariantOrder = "join") {
  const seller = context.seller!;
  const loaded = await load(ids, seller, variantOrder);
  const sellerUsername = present(seller.username) ? seller.username : seller.external_id!;
  const customers = [];
  for (const purchase of loaded.purchases)
    customers.push(await customerJson(purchase, { seller, sellerUsername, sellerContext: context, loaded }));
  return customers;
}

export async function customersProps(context: SellerContext, params: CustomersParams) {
  const seller = context.seller!;
  const product = await fetchProduct(params.linkId);
  const result = await fetchSales(seller, params, product);
  const total = result.total ?? 0;
  const loaded = await load(result.ids, seller);
  const sellerUsername = present(seller.username) ? seller.username : seller.external_id!;
  const customers = [];
  for (const purchase of loaded.purchases)
    customers.push(await customerJson(purchase, { seller, sellerUsername, sellerContext: context, loaded }));
  return {
    pagination: {
      page: params.paged ? pageOffset(params.page) / CUSTOMERS_PER_PAGE + 1 : 1,
      pages: totalPages(total),
      next: null,
    },
    product_id: product ? encrypt(product.id) : null,
    customers,
    count: total,
    products: await productsForFilterBox(seller),
    currency_type: seller.currency_type,
    countries: countryNames(),
    can_ping: await canPingSales(seller),
    show_refund_fee_notice: !UserFlags.isSet(seller.flags, "refund_fee_notice_shown"),
    license_uses_filter_enabled: await isFeatureEnabled("license_uses_sales_filter", userActor(seller.id)),
    can_send_emails: await hasCustomerAudience(seller.id),
  };
}
