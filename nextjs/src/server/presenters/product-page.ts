// The part of LinksController#show that renders Products/Show. The port serves the pages it can prove and
// hands every other request back to Rails (HandBackToRails), so no visitor gets a guess: `assertRenderable`
// builds the page once in the filter chain and turns a NotPortedError into the hand back.
import { HandBackToRails } from "../controllers/application-controller.ts";
import type { Chain } from "../controllers/application-controller.ts";
import type { Query } from "../controllers/rails-query.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { loadSellerContext, type SellerContext } from "../policies/seller-context.ts";
import { settingsProfilePolicy } from "../policies/settings/profile.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { domainConfig, assetHost } from "../page-props/domain.ts";
import { remoteIp } from "../page-props/audience/events.ts";
import { Prisma } from "@prisma/client";
import { customStyles, withDefaults } from "../models/seller-profile-styles.ts";
import { sellerProfile as loadSellerProfile, Users } from "../models/user.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { plaintextDescription, htmlSafeDescription, squish } from "./description.ts";
import { customDomainByHost, type LinkRow, type UserRow } from "./product-reads.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import { longUrl } from "./product.ts";
import { closedMembershipForNewBuyers, jsonData, minimumOfferPriceCents, productProps, remainingForSaleCount, reviewSummary, type ProductPageViewerInput } from "./product-props.ts";
import { creatorProfile } from "../page-props/settings/profile.ts";
import { setFaviconMetaTags } from "../page-props/storefront/post.ts";
import { setHostMeta } from "../page-props/storefront/post-pages.ts";
import type { MetaTagBuilder } from "../page-props/meta-tags.ts";
import type { User } from "@prisma/client";

export type RenderContext = { chain: Chain; product: LinkRow; seller: UserRow; query: Query; code: string | null; isUserCustomDomain: boolean };

const SNIPPET_MAX_LENGTH = 160;
const SNIPPET_OMISSION = "...";
const SNIPPET_TRAILING_PUNCTUATION = /[.,;:!?…]+$/u;
const UNSUPPORTED_PARAMS = ["layout", "embed", "overlay", "wanted", "purchase_id", "purchase_email_digest", "offer_code", "debug", "currency"];
const DISCOVER_RECOMMENDERS = ["search", "discover"];
const GUID_COOKIE = "_gumroad_guid";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// String#to_i
const rubyToI = (value: string) => {
  const match = /^\s*[+-]?\d+(?:_\d+)*/.exec(value);
  return match ? Number(match[0].replaceAll("_", "")) : 0;
};

// SnippetText.truncate
export function snippetTruncate(input: string, length = SNIPPET_MAX_LENGTH): string {
  const chars = Array.from(input);
  if (chars.length <= length) return input;
  const room = length - SNIPPET_OMISSION.length;
  // String#truncate(room, separator: " ", omission: "")
  const head = chars.slice(0, room + 1).join("");
  const stop = head.lastIndexOf(" ");
  const prefix = chars.slice(0, stop === -1 ? room : Array.from(head.slice(0, stop)).length).join("");
  return `${prefix.replace(SNIPPET_TRAILING_PUNCTUATION, "")}${SNIPPET_OMISSION}`;
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

function viewerOf(query: Query, code: string | null, user: User | null, context: SellerContext | null, ip: string | null, guid: string | null, sellerCustomDomainUrl: string | null, request: { host: string; hostWithPort: string; protocol: string }): ProductPageViewerInput {
  const text = (name: string) => (typeof query[name] === "string" && query[name] !== "" ? (query[name] as string) : null);
  return {
    user,
    context,
    remoteIp: ip,
    browserGuid: guid,
    // (params[:quantity] || 1).to_i
    quantity: typeof query.quantity === "string" ? rubyToI(query.quantity) : 1,
    discountCode: code,
    purchaseId: text("purchase_id"),
    purchaseEmailDigest: text("purchase_email_digest"),
    recommendedBy: text("recommended_by"),
    sellerCustomDomainUrl,
    request: { ...request, remoteIp: ip ?? "", params: {}, cookies: new Map() },
  };
}

// ApplicationController#seller_custom_domain_url
export function sellerCustomDomainUrl(isUserCustomDomain: boolean, hostWithPort: string): string | null {
  return isUserCustomDomain ? `${domainConfig(process.env).protocol}://${hostWithPort}/` : null;
}

// The meta tags of PageMeta::Product#set_product_page_meta, prepare_product_page and the action's favicon.
async function setMeta(meta: MetaTagBuilder, row: LinkRow, seller: UserRow, host: string, customDomainUrl: string | null) {
  if (row.native_type === "ebook") throw new NotPortedError("Product::StructuredData#build_ebook_structured_data");
  await setHostMeta(meta, seller as unknown as User);
  meta.set({ title: row.name });
  const html = htmlSafeDescription(row.description);
  const description = snippetTruncate(present(row.description) ? plaintextDescription(row.description) : "Available on Gumroad");
  const onOwnCustomDomain = (await customDomainByHost(host))?.user_id === row.user_id;
  const canonicalUrl = longUrl(row, seller, { host: onOwnCustomDomain && customDomainUrl ? customDomainUrl.replace(/\/$/, "") : null });

  meta.set({ name: "description", content: description });
  meta.set({ property: "gr:page:type", content: "product" });
  meta.set({ property: "product:retailer_item_id", content: row.unique_permalink });
  const priceCents = await minimumOfferPriceCents(row);
  const currency = row.price_currency_type;
  const singleUnit = ["jpy", "krw", "vnd", "clp", "pyg", "ugx", "rwf", "xaf", "xof", "xpf", "kmf", "djf", "gnf", "bif", "vuv"].includes((currency ?? "").toLowerCase());
  if (priceCents !== null && present(currency)) {
    if ((currency ?? "").toLowerCase() !== "usd") throw new NotPortedError("Product::StructuredData#usd_offer_price_cents");
    if (singleUnit) throw new NotPortedError("unit_scaling_factor of a single-unit currency");
  }
  // The price meta tags come from `product.price_cents`, which is nil for a product without a live price.
  const pagePrice = await pagePriceCents(row);
  void pagePrice;
  if (pagePrice !== null && present(currency)) {
    meta.set({ property: "product:price:amount", content: Math.round((pagePrice / 100) * 100) / 100 });
    meta.set({ property: "product:price:currency", content: currency.toUpperCase() });
  }
  meta.set({ property: "og:title", content: row.name });
  meta.set({ property: "og:description", content: description });
  meta.set({ property: "og:url", content: canonicalUrl });
  meta.set({ property: "og:type", content: ":product" });
  meta.set({ property: "twitter:title", content: row.name });
  meta.set({ property: "twitter:card", content: "summary" });
  meta.set({ property: "twitter:domain", content: "Gumroad" });
  meta.set({ property: "twitter:description", content: description.length > 200 ? `${description.slice(0, 197)}...` : description });
  if (present(seller.twitter_handle as string)) meta.set({ property: "twitter:creator", content: `@${seller.twitter_handle}` });
  meta.set({ tag_name: "link", rel: "canonical", href: canonicalUrl, head_key: "canonical" });

  const summary = (await customSummary(row)) ?? (html ? stripTags(html) : null);
  const structuredDescription = present(summary ?? "") ? snippetTruncate(squish(summary!)) : null;
  const stats = await reviewSummary(row);
  const displaysReviews = ((BigInt(row.flags as bigint | number) >> 16n) & 1n) === 1n;
  const quantityLeft = await remainingForSaleCount(row);
  const closed = await closedMembershipForNewBuyers(row);
  const availability = closed
    ? "https://schema.org/SoldOut"
    : (row.max_purchase_count ?? 0) === 0
      ? "https://schema.org/InStock"
      : quantityLeft === 0
        ? "https://schema.org/SoldOut"
        : "https://schema.org/LimitedAvailability";
  const offer: Record<string, unknown> = { "@type": "Offer", priceCurrency: present(currency) ? currency.toUpperCase() : undefined, availability, url: canonicalUrl };
  if (priceCents !== null && present(currency)) offer.price = priceCents / 100;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: row.name,
    description: structuredDescription,
    url: canonicalUrl,
    sku: row.unique_permalink,
    brand: present(seller.name) ? { "@type": "Brand", name: seller.name } : null,
    offers: Object.fromEntries(Object.entries(offer).filter(([, value]) => value !== undefined)),
  };
  if (displaysReviews && stats.count > 0) {
    data.aggregateRating = { "@type": "AggregateRating", ratingValue: Math.round(stats.average * 10) / 10, reviewCount: stats.count, bestRating: 5, worstRating: 1 };
  }
  meta.set({ tag_name: "script", type: "application/ld+json", inner_content: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null)), head_key: "structured-data" });

  const profile = await loadSellerProfile(Users.load(seller as unknown as User));
  const styles = customStyles(
    withDefaults({
      font: profile.get("font"),
      background_color: profile.get("background_color"),
      highlight_color: profile.get("highlight_color"),
      border_radius: profile.get("border_radius"),
      button_hover: profile.get("button_hover"),
    }),
  );
  meta.set({ tag_name: "style", inner_content: styles, head_key: "custom_styles" });
  if (profile.get("font") === "ABC Favorit") {
    meta.set({ tag_name: "link", rel: "preload", href: `${assetHost(domainConfig(process.env)) ?? ""}/fonts/ABCFavorit-Regular.woff2`, as: "font", type: "font/woff2", crossorigin: "anonymous", head_key: "default_font_preload" });
  }
  await setFaviconMetaTags(meta, seller as unknown as User);
}

async function customSummary(row: LinkRow): Promise<string | null> {
  const value = jsonData(row).custom_summary;
  return typeof value === "string" && present(value) ? value : null;
}

// Link#price_cents (Product::Prices#default_price_cents)
async function pagePriceCents(row: LinkRow): Promise<number | null> {
  const prices = await selectRows<{ price_cents: number; recurrence: string | null; currency: string | null; flags: number }>(
    Prisma.sql`SELECT price_cents, recurrence, currency, flags FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${row.id} AND ${column("prices", "deleted_at")} IS NULL AND ${column("prices", "currency")} = ${row.price_currency_type} ORDER BY ${column("prices", "id")} ASC`,
  );
  const types = ["buy_only", "rent_only", "buy_and_rent"];
  const type = types[row.purchase_type ?? -1];
  const isRental = (price: { flags: number }) => (Number(price.flags) & 1) === 1;
  if (type === "rent_only") return prices.filter(isRental).at(-1)?.price_cents ?? null;
  if (type !== "buy_only" && type !== "buy_and_rent") return null;
  let relevant = prices.filter((price) => !isRental(price));
  const durations = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"];
  const duration = durations[row.subscription_duration ?? -1];
  if (((BigInt(row.flags as bigint | number) >> 1n) & 1n) === 1n && duration) relevant = relevant.filter((price) => price.recurrence === duration);
  return relevant.at(-1)?.price_cents ?? null;
}

function guidOf(cookieHeader: string | null): string | null {
  const match = new RegExp(`(?:^|;\\s*)${GUID_COOKIE}=([^;]*)`).exec(cookieHeader ?? "");
  return match?.[1] && match[1] !== "" ? decodeURIComponent(match[1]) : null;
}

// The editor's extras: the seller's live, unarchived products, the posts a section could show and the wishlists.
// Posts and wishlists are handed back when there are any (a wishlist already is, in productProps).
async function editingProps(seller: UserRow) {
  const archived = 1 << 4;
  const products = await selectRows<{ id: bigint; name: string | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND (${column("links", "flags")} & ${archived}) = 0 ORDER BY ${column("links", "id")} ASC`,
  );
  const posts = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "installment_type")} = 'audience' AND ${column("installments", "workflow_id")} IS NULL LIMIT 1`,
  );
  if (posts.length > 0) throw new NotPortedError("ProfileSectionsPresenter#visible_posts");
  return { products: products.map((product) => ({ id: encrypt(product.id), name: product.name })), posts: [], wishlist_options: [] };
}

async function build(row: LinkRow, seller: UserRow, viewer: ProductPageViewerInput, meta: MetaTagBuilder, host: string) {
  const props = await productProps(row, seller, viewer);
  await setMeta(meta, row, seller, host, viewer.sellerCustomDomainUrl);
  const storefront = ((BigInt(seller.flags as bigint | number) >> 57n) & 1n) === 1n;
  if (storefront) throw new NotPortedError("ProductPresenter#profile_product_props");
  const [section] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "product_id")} = ${row.id} LIMIT 1`,
  );
  if (section) throw new NotPortedError("ProfileSectionsPresenter for a product's sections");
  const data = jsonData(row);
  // ProfileSectionsPresenter#props `editing: pundit_user.seller == seller`
  const editing = viewer.context?.seller?.id === seller.id;
  const [hasReviews] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND (${column("links", "flags")} & ${1 << 16}) != 0 LIMIT 1`,
  );
  return {
    ...props,
    currency_code: viewer.user?.currency_type || "usd",
    show_ratings_filter: !!hasReviews,
    creator_profile: await creatorProfile(seller as unknown as Parameters<typeof creatorProfile>[0], !!viewer.context?.user && viewer.context.seller?.id === seller.id && settingsProfilePolicy.update(viewer.context)),
    sections: [],
    main_section_index: Number(data?.main_section_index ?? 0) || 0,
    ...(editing ? await editingProps(seller) : {}),
  };
}

export async function assertRenderable(context: RenderContext): Promise<void> {
  const { chain, product, seller, query, code } = context;
  for (const name of UNSUPPORTED_PARAMS) if (name in query) throw new HandBackToRails();
  if (typeof query.recommended_by === "string" && DISCOVER_RECOMMENDERS.includes(query.recommended_by)) throw new HandBackToRails();
  try {
    const user = railsLoggedInUser(chain.auth.context);
    const viewer = viewerOf(query, code, user, user ? await loadSellerContext(chain.auth.context) : null, remoteIp(chain.request.headers), chain.request.cookies.get(GUID_COOKIE) ?? null, sellerCustomDomainUrl(context.isUserCustomDomain, chain.request.hostWithPort), chain.request);
    await build(product, seller, viewer, new (await import("../page-props/meta-tags.ts")).MetaTagBuilder(), chain.request.host);
    // set_noindex_header if !@product.alive?
    if (product.purchase_disabled_at !== null || product.banned_at !== null || product.deleted_at !== null) chain.headers.set("x-robots-tag", "noindex");
  } catch (error) {
    if (error instanceof NotPortedError) {
      if (process.env.PRODUCT_PAGE_DEBUG) console.error(`product page handed back: ${error.message}`);
      throw new HandBackToRails();
    }
    throw error;
  }
}

export { build as buildProductPage, guidOf, viewerOf };
