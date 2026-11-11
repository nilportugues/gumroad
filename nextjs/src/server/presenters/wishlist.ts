// Port of WishlistPresenter#public_items and #public_props (for a visitor with no session), PageMeta::Wishlist and
// Wishlist::StructuredData: what the wishlist page and its "load more" endpoint share.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { unitScalingFactor } from "../models/concerns/currency-helper.ts";
import { rubyRound } from "../models/concerns/ruby-numeric.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { RISK_STATES, UserFlags } from "../models/user.ts";
import { MetaTagBuilder, parameterize } from "../page-props/meta-tags.ts";
import { avatarUrl, displayName } from "../page-props/signed-in/presenters.ts";
import { timeAsJson } from "../search/es-json.ts";

import { squish } from "./description.ts";
import { snippetTruncate } from "./product-page.ts";
import { variantToOption } from "./product-props.ts";
import { alivePrices, findLink, findUserById, type LinkRow, type UserRow } from "./product-reads.ts";
import { cardForWeb, longUrl, subdomainWithProtocol, type PresenterRequest } from "./product.ts";

// WishlistPresenter::PER_PAGE
const PER_PAGE = 20;
// RecommendationType::WISHLIST_RECOMMENDATION
const WISHLIST_RECOMMENDATION = "wishlist";
// Wishlist::StructuredData::ITEM_LIST_LIMIT
const ITEM_LIST_LIMIT = 20;
// Wishlist::MINIMUM_SEO_INDEXABLE_PRODUCTS
const MINIMUM_SEO_INDEXABLE_PRODUCTS = 3;
// Wishlist `has_flags 1 => :discover_opted_out`
const DISCOVER_OPTED_OUT = 1n;
// Product::Layout::PROFILE and DISCOVER
const PROFILE_LAYOUT = "profile";
const DISCOVER_LAYOUT = "discover";
const SCHEMA_ORG_CONTEXT = "https://schema.org";

export type WishlistRow = {
  id: bigint;
  user_id: bigint;
  name: string;
  description: string | null;
  recommendable: boolean | number;
  flags: bigint | number;
};

type WishlistProductRow = {
  id: bigint;
  product_id: bigint;
  variant_id: bigint | null;
  recurrence: string | null;
  quantity: number;
  rent: boolean | number;
  created_at: Date;
};

const ALIVE_WISHLIST_PRODUCTS = (wishlistId: bigint) =>
  Prisma.sql`${column("wishlist_products", "wishlist_id")} = ${wishlistId} AND ${column("wishlist_products", "deleted_at")} IS NULL`;

// Wishlist#external_id_numeric
const externalIdNumeric = (wishlist: Pick<WishlistRow, "id">) => encryptNumeric(Number(wishlist.id));

// Wishlist#url_slug
export const urlSlug = (wishlist: WishlistRow) => `${parameterize(wishlist.name)}-${externalIdNumeric(wishlist)}`;

// `wishlist_url(wishlist.url_slug, host: wishlist.user.subdomain_with_protocol)`
export function wishlistUrl(wishlist: WishlistRow, owner: UserRow): string {
  return `${subdomainWithProtocolOf(owner)}/wishlists/${urlSlug(wishlist)}`;
}

// User#subdomain_with_protocol; a wishlist is only reachable on a host that has a username.
function subdomainWithProtocolOf(user: UserRow): string {
  const base = subdomainWithProtocol(user);
  if (base === null) throw new HandBackToRails("a wishlist owner without a username");
  return base;
}

// `Link#alive?` and `Link#published?`
const aliveProduct = (row: LinkRow) =>
  row.purchase_disabled_at === null && row.banned_at === null && row.deleted_at === null;
const publishedProduct = (row: LinkRow) => row.deleted_at === null && row.purchase_disabled_at === null && !row.draft;

// `Link#can_gift?`: `!is_in_preorder_state && !user.gifting_disabled?`
async function canGift(row: LinkRow): Promise<boolean> {
  const seller = row.user_id === null ? null : await findUserById(row.user_id);
  if (seller === null) throw new HandBackToRails("a product without a seller");
  return !LinkFlags.isSet(row.flags, "is_in_preorder_state") && !UserFlags.isSet(seller.flags, "gifting_disabled");
}

// `wishlist.user.global_affiliate&.external_id_numeric&.to_s`
async function globalAffiliateId(userId: bigint): Promise<string | null> {
  const [affiliate] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'GlobalAffiliate' AND ${column("affiliates", "affiliate_user_id")} = ${userId} AND ${column("affiliates", "deleted_at")} IS NULL ORDER BY ${column("affiliates", "id")} ASC LIMIT 1`,
  );
  return affiliate ? String(encryptNumeric(Number(affiliate.id))) : null;
}

async function option(row: LinkRow, variantId: bigint | null) {
  if (variantId === null) return null;
  const [variant] = await selectRows<Parameters<typeof variantToOption>[1]>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${variantId} LIMIT 1`,
  );
  if (!variant) throw new HandBackToRails("a wishlist product whose version is missing");
  return variantToOption(row, variant, await alivePrices(row.id), row.user_id!);
}

// WishlistPresenter#public_items; `page` is already a positive integer (Pagy refuses the rest).
export async function publicItems(
  wishlist: WishlistRow,
  {
    request,
    currentSellerId,
    recommendedBy,
    page,
  }: { request: PresenterRequest; currentSellerId: bigint | null; recommendedBy?: string | null; page: number },
) {
  const [counted] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("wishlist_products")} WHERE ${ALIVE_WISHLIST_PRODUCTS(wishlist.id)}`,
  );
  const total = Number(counted!.count);
  const pages = Math.max(Math.ceil(total / PER_PAGE), 1);
  // `overflow: :empty_page`: the page asked for stays, with no items and `prev` the last page.
  const overflowed = page > pages;
  const wishlistProducts = overflowed
    ? []
    : await selectRows<WishlistProductRow>(
        Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table("wishlist_products")} WHERE ${ALIVE_WISHLIST_PRODUCTS(wishlist.id)} ORDER BY ${column("wishlist_products", "id")} ASC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
      );

  const affiliateId = await globalAffiliateId(wishlist.user_id);
  const items = [];
  for (const wishlistProduct of wishlistProducts) {
    const product = await findLink(wishlistProduct.product_id);
    if (product === null) throw new HandBackToRails("a wishlist product whose product is missing");
    items.push({
      id: encrypt(wishlistProduct.id),
      product: await cardForWeb(wishlistProduct.product_id, {
        request,
        // `recommended_by || RecommendationType::WISHLIST_RECOMMENDATION`
        recommendedBy: recommendedBy ?? WISHLIST_RECOMMENDATION,
        affiliateId,
      }),
      option: await option(product, wishlistProduct.variant_id),
      recurrence: wishlistProduct.recurrence,
      quantity: wishlistProduct.quantity,
      rent: Boolean(wishlistProduct.rent),
      created_at: timeAsJson(wishlistProduct.created_at),
      purchasable: aliveProduct(product) && publishedProduct(product),
      giftable: (await canGift(product)) && wishlist.user_id !== currentSellerId,
    });
  }

  return {
    items,
    // PagyPresenter#metadata
    pagination: {
      count: total,
      items: overflowed ? 0 : PER_PAGE,
      page,
      pages,
      prev: page > 1 ? Math.min(page - 1, pages) : null,
      next: page < pages ? page + 1 : null,
      last: pages,
    },
  };
}

// `alive_wishlist_products.available_to_buy.any?`: a live product of an account that is not suspended.
export async function checkoutEnabled(wishlist: WishlistRow): Promise<boolean> {
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("wishlist_products")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("wishlist_products", "product_id")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("links", "user_id")} WHERE ${ALIVE_WISHLIST_PRODUCTS(wishlist.id)} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("users", "user_risk_state")} NOT IN (${Prisma.join([...RISK_STATES.SUSPENDED])}) LIMIT 1`,
  );
  return row !== undefined;
}

async function distinctProductCount(wishlist: WishlistRow): Promise<number> {
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(DISTINCT ${column("wishlist_products", "product_id")}) AS count FROM ${table("wishlist_products")} WHERE ${ALIVE_WISHLIST_PRODUCTS(wishlist.id)}`,
  );
  return Number(row!.count);
}

// Wishlist::StructuredData#structured_data_item
function structuredDataItem(product: LinkRow, seller: UserRow) {
  const url = longUrl(product, seller);
  const item: Record<string, unknown> = { "@type": "Product", name: product.name, url };
  const priceCents = product.price_cents as number | null;
  const currency = product.price_currency_type;
  if (priceCents !== null && currency !== null && currency.trim() !== "") {
    item.offers = {
      "@type": "Offer",
      // (price_cents / unit_scaling_factor(currency).to_f).round(2)
      price: rubyRound((priceCents / unitScalingFactor(currency)) * 100) / 100,
      priceCurrency: currency.toUpperCase(),
      url,
    };
  }
  return item;
}

// Wishlist::StructuredData#structured_data: the first page's products, each once.
async function structuredData(wishlist: WishlistRow): Promise<Record<string, unknown> | null> {
  const rows = await selectRows<{ product_id: bigint }>(
    Prisma.sql`SELECT ${column("wishlist_products", "product_id")} FROM ${table("wishlist_products")} WHERE ${ALIVE_WISHLIST_PRODUCTS(wishlist.id)} ORDER BY ${column("wishlist_products", "id")} ASC LIMIT ${ITEM_LIST_LIMIT}`,
  );
  const ids = [...new Set(rows.map((row) => String(row.product_id)))];
  if (ids.length === 0) return null;
  const itemListElement = [];
  for (const [index, id] of ids.entries()) {
    const product = (await findLink(BigInt(id)))!;
    const seller = product.user_id === null ? null : await findUserById(product.user_id);
    if (seller === null) throw new HandBackToRails("a wishlist product without a seller");
    itemListElement.push({ "@type": "ListItem", position: index + 1, item: structuredDataItem(product, seller) });
  }
  return {
    "@context": SCHEMA_ORG_CONTEXT,
    "@type": "ItemList",
    name: wishlist.name,
    numberOfItems: ids.length,
    itemListElement,
  };
}

// PageMeta::Wishlist#set_wishlist_page_meta
export async function setWishlistPageMeta(meta: MetaTagBuilder, wishlist: WishlistRow, owner: UserRow): Promise<void> {
  const canonicalUrl = wishlistUrl(wishlist, owner);
  const description = await metaDescription(wishlist, owner);

  meta.set({ title: `${wishlist.name} — curated digital products | Gumroad` });
  meta.set({ name: "description", content: description });
  meta.set({ property: "og:title", content: wishlist.name });
  meta.set({ property: "og:description", content: description });
  meta.set({ property: "og:url", content: canonicalUrl });
  meta.set({ property: "og:type", content: "website" });
  meta.set({ tag_name: "link", rel: "canonical", href: canonicalUrl, head_key: "canonical" });

  // Wishlist#seo_indexable?
  if (Boolean(wishlist.recommendable) && (await distinctProductCount(wishlist)) >= MINIMUM_SEO_INDEXABLE_PRODUCTS) {
    meta.set({ name: "robots", content: "index,follow" });
    const data = await structuredData(wishlist);
    if (data !== null)
      meta.set({ tag_name: "script", type: "application/ld+json", inner_content: data, head_key: "structured-data" });
  } else {
    meta.set({ name: "robots", content: "noindex" });
  }
}

async function metaDescription(wishlist: WishlistRow, owner: UserRow): Promise<string> {
  if (wishlist.description !== null && wishlist.description.trim() !== "")
    return snippetTruncate(squish(wishlist.description));
  const count = await distinctProductCount(wishlist);
  const name = displayName(owner as unknown as User);
  return `${wishlist.name} — a wishlist of ${count} ${count === 1 ? "digital product" : "digital products"} curated by ${name} on Gumroad.`;
}

// WishlistPresenter#public_props. `pundit_user`: `userId` is its user, `sellerId` the account it acts on. A `layout` adds the
// profile or discover navigation, which the caller supplies (`creatorProfile`, `taxonomiesForNav`).
export async function publicProps(
  wishlist: WishlistRow,
  owner: UserRow,
  options: {
    request: PresenterRequest;
    recommendedBy?: string | null;
    pundit?: { userId: bigint | null; sellerId: bigint | null };
    layout?: string | null;
    creatorProfile?: () => Promise<unknown>;
    taxonomiesForNav?: () => Promise<unknown>;
  },
) {
  const { userId = null, sellerId = null } = options.pundit ?? {};
  const items = await publicItems(wishlist, { ...options, currentSellerId: sellerId, page: 1 });
  // WishlistPolicy#update?: `role_owner_for?(seller) && record.user == user`
  const canEdit = userId !== null && sellerId === userId && wishlist.user_id === userId;
  const [follower] =
    sellerId === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("wishlist_followers")} WHERE ${column("wishlist_followers", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_followers", "deleted_at")} IS NULL AND ${column("wishlist_followers", "follower_user_id")} = ${sellerId} LIMIT 1`,
        );
  const props: Record<string, unknown> = {
    id: encrypt(wishlist.id),
    name: wishlist.name,
    description: wishlist.description,
    url: wishlistUrl(wishlist, owner),
    user:
      owner.id !== sellerId
        ? {
            name: displayName(owner as unknown as User),
            profile_url: subdomainWithProtocolOf(owner),
            avatar_url: await avatarUrl(owner as unknown as User),
          }
        : null,
    following: follower !== undefined,
    can_follow: sellerId !== wishlist.user_id,
    can_edit: canEdit,
    discover_opted_out: canEdit ? (BigInt(wishlist.flags) & DISCOVER_OPTED_OUT) !== 0n : null,
    checkout_enabled: await checkoutEnabled(wishlist),
    ...items,
  };
  const layout = options.layout;
  if (layout != null && layout.trim() !== "") props.layout = layout;
  if (layout === PROFILE_LAYOUT && options.creatorProfile) props.creator_profile = await options.creatorProfile();
  else if (layout === DISCOVER_LAYOUT && options.taxonomiesForNav)
    props.taxonomies_for_nav = await options.taxonomiesForNav();
  return props;
}
