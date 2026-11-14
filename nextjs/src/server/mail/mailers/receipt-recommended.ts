// The recommended products section of a receipt (ReceiptPresenter::RecommendedProductsInfo): the sales-related
// cache (SalesRelatedProductsInfo.related_products), the creator-featured search that fills what is missing
// (RecommendedProducts::CheckoutService#result), the preloads of ProductPresenter::Card::ASSOCIATIONS and the
// cards (ProductPresenter::Card#for_web) the email's product card partial renders.
//
// Rails loads every card association with `includes`, so the cards cost no statements of their own: the preloads here
// are sent in the order Rails' preloader sends them, and each association that has rows (a thumbnail, a variant
// category, a sale) goes back to Rails instead, because the card then depends on rows this does not read.
import { Prisma } from "@prisma/client";

import { domainConfig } from "../../infra/domain.ts";
import { formattedPrice } from "../../models/concerns/money-formatter.ts";
import { selectRows, table, column, columnIn, columnNotIn, inList } from "../../models/sql.ts";
import type { LinkRow, PriceRow } from "../../presenters/product-reads.ts";
import { displayPriceCents, linkFields, longUrl, type PricedProduct } from "../../presenters/product.ts";
import { searchProductsWithFacets } from "../../search/search-products.ts";
import { MailViewNotPortedError } from "../views.ts";

type Id = number | bigint;

// RecommendedProductsInfo::RECOMMENDED_PRODUCTS_LIMIT and RecommendedProducts::BaseService::NUMBER_OF_RESULTS
export const RECOMMENDED_PRODUCTS_LIMIT = 4;
const RELATED_PRODUCTS_LIMIT = 40;
const RELATED_PRODUCTS_SLICE = 100;
// BaseService#fetch_recommended_products samples half of the associated ids from this many on.
export const SAMPLED_ASSOCIATED_IDS = 4;

const RECOMMENDED_BY = "receipt";
const RECOMMENDER_MODEL_NAME = "sales";
const TARGET = "profile";
const CO_PURCHASE = "co_purchase";
const CREATOR_FEATURED = "creator_featured";

export type RecommendedCard = {
  name: string;
  url: string;
  thumbnailUrl: string;
  ratings: { count: number; average: number } | null;
  priceCents: number;
  currencyCode: string;
  isPayWhatYouWant: boolean;
};
export type RecommendedProducts = { title: string; cards: RecommendedCard[] };

type CardLink = LinkRow & { id: bigint; user_id: bigint };
type ProductInfo = { link: CardLink; source: typeof CO_PURCHASE | typeof CREATOR_FEATURED };

const star = (tableName: string) => Prisma.raw(`\`${tableName}\`.*`);
const rows = (statement: Prisma.Sql) => selectRows<Record<string, unknown>>(statement);
const num = (value: Id) => Number(value);

// SalesRelatedProductsInfo.related_products: the cached counts of every id, summed, the requested ids removed, then
// the highest sales count first (the higher product id first on a tie).
async function relatedProductIds(productIds: Id[]): Promise<number[]> {
  const counts = new Map<number, number>();
  for (let start = 0; start < productIds.length; start += RELATED_PRODUCTS_SLICE) {
    const slice = productIds.slice(start, start + RELATED_PRODUCTS_SLICE);
    const infos = await rows(
      Prisma.sql`SELECT ${star("cached_sales_related_products_infos")} FROM ${table("cached_sales_related_products_infos")} WHERE ${columnIn("cached_sales_related_products_infos", "product_id", slice)}`,
    );
    for (const info of infos) {
      const raw = info.counts;
      const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, number> | null;
      // normalized_counts is nil for a NULL column, which Ruby then fails to enumerate
      if (parsed === null || typeof parsed !== "object")
        throw new MailViewNotPortedError("cached related products without counts");
      for (const [productId, salesCount] of Object.entries(parsed)) {
        if (!/^\d+$/u.test(productId) || !Number.isInteger(salesCount))
          throw new MailViewNotPortedError("cached related products with an unexpected shape");
        counts.set(Number(productId), (counts.get(Number(productId)) ?? 0) + salesCount);
      }
    }
  }
  const requested = new Set(productIds.map(num));
  return [...counts.entries()]
    .filter(([productId]) => !requested.has(productId))
    .sort(([idA, countA], [idB, countB]) => (countB !== countA ? countB - countA : idB - idA))
    .slice(0, RELATED_PRODUCTS_LIMIT)
    .map(([productId]) => productId);
}

// `Link.alive`: purchase_disabled_at, banned_at and deleted_at all NULL.
const ALIVE = Prisma.raw(
  "`links`.`purchase_disabled_at` IS NULL AND `links`.`banned_at` IS NULL AND `links`.`deleted_at` IS NULL",
);
const NOT_ARCHIVED = Prisma.raw("((`links`.`flags` & 16 = 0))");

// ProductPresenter::Card::ASSOCIATIONS, preloaded for products of one seller. Every association the card does not
// read through a row this port understands sends the delivery back to Rails once it turns out to have rows.
type Preloaded = {
  prices: Map<string, PriceRow[]>;
  reviewStats: Map<string, { reviews_count: number; average_rating: number }>;
};

async function preloadCardAssociations(links: CardLink[]): Promise<Preloaded> {
  const ids = links.map((link) => link.id);
  const sellerIds = [...new Set(links.map((link) => link.user_id))];
  const refuseIfAny = async (statement: Prisma.Sql, what: string) => {
    if ((await rows(statement)).length > 0) throw new MailViewNotPortedError(`recommended product with ${what}`);
  };
  const pricesRows = await rows(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "deleted_at")} IS NULL AND ${columnIn("prices", "link_id", ids)}`,
  );
  const stats = await rows(
    Prisma.sql`SELECT ${star("product_review_stats")} FROM ${table("product_review_stats")} WHERE ${columnIn("product_review_stats", "link_id", ids)}`,
  );
  await refuseIfAny(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Sku' AND ${columnIn("base_variants", "link_id", ids)}`,
    "a SKU",
  );
  await rows(Prisma.sql`SELECT ${star("users")} FROM ${table("users")} WHERE ${columnIn("users", "id", sellerIds)}`);
  await refuseIfAny(
    Prisma.sql`SELECT ${star("thumbnails")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "deleted_at")} IS NULL AND ${columnIn("thumbnails", "product_id", ids)}`,
    "a thumbnail",
  );
  await refuseIfAny(
    Prisma.sql`SELECT ${star("asset_previews")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "deleted_at")} IS NULL AND ${columnIn("asset_previews", "link_id", ids)} ORDER BY ${column("asset_previews", "position")} ASC, ${column("asset_previews", "created_at")} ASC`,
    "an asset preview",
  );
  await refuseIfAny(
    Prisma.sql`SELECT ${star("bundle_products")} FROM ${table("bundle_products")} WHERE ${columnIn("bundle_products", "bundle_id", ids)}`,
    "bundle products",
  );
  // Link#tiers
  await refuseIfAny(
    Prisma.sql`SELECT \`variant_categories\`.\`id\` AS t0_r0, \`variant_categories\`.\`link_id\` AS t0_r1, \`variant_categories\`.\`deleted_at\` AS t0_r2, \`variant_categories\`.\`title\` AS t0_r3, \`variant_categories\`.\`flags\` AS t0_r4, \`base_variants\`.\`id\` AS t1_r0, \`base_variants\`.\`variant_category_id\` AS t1_r1, \`base_variants\`.\`price_difference_cents\` AS t1_r2, \`base_variants\`.\`name\` AS t1_r3, \`base_variants\`.\`max_purchase_count\` AS t1_r4, \`base_variants\`.\`deleted_at\` AS t1_r5, \`base_variants\`.\`created_at\` AS t1_r6, \`base_variants\`.\`updated_at\` AS t1_r7, \`base_variants\`.\`type\` AS t1_r8, \`base_variants\`.\`link_id\` AS t1_r9, \`base_variants\`.\`custom_sku\` AS t1_r10, \`base_variants\`.\`flags\` AS t1_r11, \`base_variants\`.\`description\` AS t1_r12, \`base_variants\`.\`position_in_category\` AS t1_r13, \`base_variants\`.\`customizable_price\` AS t1_r14, \`base_variants\`.\`subscription_price_change_effective_date\` AS t1_r15, \`base_variants\`.\`subscription_price_change_message\` AS t1_r16, \`base_variants\`.\`duration_in_minutes\` AS t1_r17, \`base_variants\`.\`sales_count_for_inventory_cache\` AS t1_r18 FROM \`variant_categories\` LEFT OUTER JOIN \`base_variants\` ON \`base_variants\`.\`deleted_at\` IS NULL AND \`base_variants\`.\`variant_category_id\` = \`variant_categories\`.\`id\` AND \`base_variants\`.\`type\` = 'Variant' WHERE \`variant_categories\`.\`deleted_at\` IS NULL AND \`variant_categories\`.\`title\` = 'Tier' AND \`base_variants\`.\`type\` = 'Variant' AND \`base_variants\`.\`deleted_at\` IS NULL AND ${columnIn("variant_categories", "link_id", ids)}`,
    "a tier",
  );
  await refuseIfAny(
    Prisma.sql`SELECT ${star("variant_categories")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "deleted_at")} IS NULL AND ${columnIn("variant_categories", "link_id", ids)}`,
    "a variant category",
  );
  await rows(
    Prisma.sql`SELECT ${star("custom_domains")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "deleted_at")} IS NULL AND ${columnIn("custom_domains", "user_id", sellerIds)}`,
  );
  // User#auto_apply_offer_code: a seller-wide sale discounts every card
  await refuseIfAny(
    Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = TRUE AND ${column("offer_codes", "auto_apply")} = TRUE AND ${column("offer_codes", "new_customers_only")} = FALSE AND ${columnIn("offer_codes", "user_id", sellerIds)} ORDER BY ${column("offer_codes", "id")} ASC`,
    "a seller-wide sale",
  );
  await refuseIfAny(
    Prisma.sql`SELECT ${star("active_storage_attachments")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_type")} = 'User' AND ${column("active_storage_attachments", "name")} = 'avatar' AND ${columnIn("active_storage_attachments", "record_id", sellerIds)}`,
    "a seller with an uploaded avatar",
  );

  const prices = new Map<string, PriceRow[]>();
  for (const price of pricesRows) {
    const key = String(price.link_id);
    prices.set(key, [...(prices.get(key) ?? []), price as unknown as PriceRow]);
  }
  const reviewStats = new Map(
    stats.map((stat) => [
      String(stat.link_id),
      { reviews_count: Number(stat.reviews_count), average_rating: Number(stat.average_rating) },
    ]),
  );
  return { prices, reviewStats };
}

// What ProductPresenter::Card#for_web needs from a product that is a plain one-time purchase.
function assertPlainProduct(link: CardLink): void {
  const refuse = (what: string): never => {
    throw new MailViewNotPortedError(`recommended product ${what}`);
  };
  if (linkFields.isRecurring(link) || linkFields.isTiered(link) || linkFields.isBundle(link))
    refuse("that is a membership or bundle");
  if (linkFields.purchaseType(link) !== "buy_only") refuse("that can be rented");
  if (link.max_purchase_count !== null) refuse("with a purchase limit");
  if (link.default_offer_code_id !== null) refuse("with a default offer code");
  if (linkFields.subscriptionDuration(link) !== null) refuse("with a subscription duration");
}

function card(link: CardLink, seller: { username: string | null }, preloaded: Preloaded): RecommendedCard {
  assertPlainProduct(link);
  const key = String(link.id);
  const priced: PricedProduct = { link, prices: preloaded.prices.get(key) ?? [], priceDifference: null };
  const stat = preloaded.reviewStats.get(key);
  const assetHost = domainConfig().assetHost ?? "";
  return {
    name: link.name ?? "",
    url: longUrl(link, seller as never, {
      recommendedBy: RECOMMENDED_BY,
      recommenderModelName: RECOMMENDER_MODEL_NAME,
      layout: TARGET,
    }),
    thumbnailUrl: `${assetHost}/images/native_types/thumbnails/${link.native_type}.png`,
    ratings: linkFields.displaysReviews(link)
      ? { count: stat?.reviews_count ?? 0, average: stat?.average_rating ?? 0 }
      : null,
    priceCents: displayPriceCents(priced),
    currencyCode: linkFields.currency(link),
    isPayWhatYouWant: !!link.customizable_price,
  };
}

async function loadCardLinks(statement: Prisma.Sql): Promise<CardLink[]> {
  return (await rows(statement)) as unknown as CardLink[];
}

// RecommendedProducts::CheckoutService#result for the receipt: related products first, then the creator's featured ones.
export async function recommendedProducts(args: {
  cartProductIds: Id[];
  // find_associated_product_ids(limit:), the ids the related products are looked up for
  associatedIds: Id[];
  // exclude_product_ids
  excludeIds: Id[];
  sellerIds: Id[];
  seller: { username: string | null };
}): Promise<RecommendedProducts | null> {
  const { associatedIds, excludeIds, sellerIds, seller } = args;
  const infos: ProductInfo[] = [];
  const related = await relatedProductIds(associatedIds);
  const preloaded: Preloaded[] = [];
  const loaded: CardLink[] = [];

  if (related.length > 0) {
    const links = await loadCardLinks(
      Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", related)} AND ${column("links", "id")} IN ${inList(related)} AND ${columnIn("links", "user_id", sellerIds)} AND ${ALIVE} AND ${columnNotIn("links", "id", excludeIds)} AND ${ALIVE} AND ${NOT_ARCHIVED} ORDER BY CASE ${Prisma.join(
        related.map((id, index) => Prisma.sql`WHEN ${column("links", "id")} = ${id} THEN ${index + 1}`),
        " ",
      )} END ASC`,
    );
    if (links.length > 0) {
      preloaded.push(await preloadCardAssociations(links));
      for (const link of links) {
        loaded.push(link);
        // `cart_seller_ids.include?(product.user_id)`: the query already limits to them
        infos.push({ link, source: CO_PURCHASE });
      }
    }
  }
  const taken = infos.slice(0, RECOMMENDED_PRODUCTS_LIMIT);

  let featured: ProductInfo[] = [];
  let featuredPreloaded: Preloaded | null = null;
  if (taken.length < RECOMMENDED_PRODUCTS_LIMIT && sellerIds.length > 0) {
    const searched = await searchProductsWithFacets({
      size: RECOMMENDED_PRODUCTS_LIMIT - taken.length,
      sort: "featured",
      user_id: sellerIds.map(num),
      is_alive_on_profile: true,
      exclude_ids: [...new Set([...excludeIds, ...taken.map((info) => info.link.id)].map(num))],
    });
    if (searched.product_ids.length > 0) {
      const ids = searched.product_ids.map(Number);
      const fetched = await loadCardLinks(
        Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", ids)}`,
      );
      const links = ids.flatMap((id) => fetched.filter((link) => num(link.id) === id));
      if (links.length > 0) {
        featuredPreloaded = await preloadCardAssociations(links);
        featured = links.map((link) => ({ link, source: CREATOR_FEATURED }));
      }
    }
  }

  const all = [...taken, ...featured];
  if (all.length === 0) return null;
  const merged: Preloaded = { prices: new Map(), reviewStats: new Map() };
  for (const part of [...preloaded, ...(featuredPreloaded ? [featuredPreloaded] : [])]) {
    for (const [key, value] of part.prices) merged.prices.set(key, value);
    for (const [key, value] of part.reviewStats) merged.reviewStats.set(key, value);
  }
  void loaded;

  const cards = all.map((info) => card(info.link, seller, merged));
  const title = all.every((info) => info.source === CO_PURCHASE)
    ? `Customers who bought ${args.cartProductIds.length === 1 ? "this item" : "these items"} also bought`
    : new Set(all.map((info) => String(info.link.user_id))).size === 1
      ? "More from this creator"
      : "You may also like";
  return { title, cards };
}

// CurrencyHelper#product_card_formatted_price for a one-time product (no recurrence label).
export const cardPrice = (card: RecommendedCard) =>
  `${formattedPrice(card.currencyCode, card.priceCents)}${card.isPayWhatYouWant ? "+" : ""}`;

// ApplicationHelper#number_to_si: number_to_human with precision 1, truncating, no insignificant zeros.
export function numberToSi(count: number): string {
  const units = ["", "K", "M", "B", "T"];
  let scale = 0;
  while (scale < units.length - 1 && count >= 1000 ** (scale + 1)) scale += 1;
  const tenths = Math.floor((count * 10) / 1000 ** scale);
  const whole = Math.trunc(tenths / 10);
  const fraction = tenths % 10;
  return `${whole}${fraction === 0 ? "" : `.${fraction}`}${units[scale]}`;
}

// Float#to_s for a rating
export const floatToS = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));
