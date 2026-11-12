// The part of LinksController#show that renders Products/Show. The port serves the pages it can prove and
// hands every other request back to Rails (HandBackToRails), so no visitor gets a guess: `assertRenderable`
// builds the page once in the filter chain and turns a NotPortedError into the hand back.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import type { Chain } from "../controllers/application-controller.ts";
import type { Query } from "../controllers/rails-query.ts";
import { viteAssetPath } from "../infra/vite.ts";
import { cachedRate, getUsdCents, rubyStringToF, unitScalingFactor } from "../models/concerns/currency-helper.ts";
import { customStyles, withDefaults } from "../models/seller-profile-styles.ts";
import { sellerProfile as loadSellerProfile, Users } from "../models/user.ts";
import { remoteIp } from "../page-props/audience/events.ts";
import { domainConfig, assetHost } from "../page-props/domain.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { loadSellerContext, type SellerContext } from "../policies/seller-context.ts";
import { settingsProfilePolicy } from "../policies/settings/profile.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { plaintextDescription, htmlSafeDescription, squish } from "./description.ts";
import {
  closedMembershipForNewBuyers,
  jsonData,
  minimumOfferPriceCents,
  productProps,
  remainingForSaleCount,
  reviewSummary,
  type ProductPageViewerInput,
} from "./product-props.ts";
import { addressableEscape } from "./asset-preview.ts";
import { coverProps } from "./product-props-extras.ts";
import { customDomainByHost, type LinkRow, type UserRow } from "./product-reads.ts";
import { longUrl } from "./product.ts";

import { creatorProfile, visiblePosts } from "../page-props/settings/profile.ts";
import { setFaviconMetaTags } from "../page-props/storefront/post.ts";
import { setHostMeta } from "../page-props/storefront/post-pages.ts";
import { storefrontCatalogSections } from "../page-props/storefront/catalog.ts";
import { visitorSearchParams } from "../page-props/storefront/product-sections.ts";
import { createDiscoverSearch, hasCuratedProductSources } from "../page-props/discover/discover.ts";
import { taxonomiesForNav } from "../page-props/discover/taxonomies.ts";
import type { MetaTagBuilder } from "../page-props/meta-tags.ts";

export type RenderContext = {
  chain: Chain;
  product: LinkRow;
  seller: UserRow;
  query: Query;
  code: string | null;
  isUserCustomDomain: boolean;
};

const SNIPPET_MAX_LENGTH = 160;
const SNIPPET_OMISSION = "...";
const SNIPPET_TRAILING_PUNCTUATION = /[.,;:!?…]+$/u;
const UNSUPPORTED_PARAMS = [
  "wanted",
  "purchase_id",
  "purchase_email_digest",
  "offer_code",
  "debug",
  "currency",
];
const DISCOVER_RECOMMENDERS = ["search", "discover"];
const GUID_COOKIE = "_gumroad_guid";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

type CoverMeta = {
  url: string | null;
  type: string;
  thumbnail: string | null;
  native_width: number | null;
  native_height: number | null;
};

export type ProductPageKind = "show" | "iframe" | "profile" | "discover";

// The branch of LinksController#show that picks the Inertia component: `layout` first, then `embed` or `overlay` (any value,
// even a blank one: `params[:embed] || params[:overlay]`), then a storefront seller's page for anyone but the seller, which
// shares Products/Profile/Show with the profile layout.
export function productPageKind(query: Query, storefrontWrapped = false): ProductPageKind {
  if (query.layout === "profile") return "profile";
  if (query.layout === "discover") return "discover";
  if (query.embed !== undefined || query.overlay !== undefined) return "iframe";
  return storefrontWrapped ? "profile" : "show";
}

// `product.user.product_page_storefront_enabled?`
const storefrontEnabled = (seller: UserRow) => ((BigInt(seller.flags as bigint | number) >> 57n) & 1n) === 1n;

// `product_page_storefront_enabled? && pundit_user&.seller != product.user`
export const isStorefrontWrapped = (seller: UserRow, viewer: { context: SellerContext | null }) =>
  storefrontEnabled(seller) && viewer.context?.seller?.id !== seller.id;

export const PRODUCT_PAGE_COMPONENTS: Record<ProductPageKind, string> = {
  show: "Products/Show",
  iframe: "Products/Iframe/Show",
  profile: "Products/Profile/Show",
  discover: "Products/Discover/Show",
};

// String#to_i
const rubyToI = (value: string) => {
  const match = /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
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

const stripTags = (html: string) => html.replace(/<[^>]*>/gu, "");

function viewerOf(
  query: Query,
  code: string | null,
  user: User | null,
  context: SellerContext | null,
  ip: string | null,
  guid: string | null,
  sellerCustomDomainUrl: string | null,
  request: { host: string; hostWithPort: string; protocol: string },
): ProductPageViewerInput {
  const text = (name: string) =>
    typeof query[name] === "string" && query[name] !== "" ? (query[name] as string) : null;
  return {
    user,
    context,
    remoteIp: ip,
    browserGuid: guid,
    // (params[:quantity] || 1).to_i
    quantity: typeof query.quantity === "string" ? rubyToI(query.quantity) : 1,
    discountCode: code,
    layout: text("layout"),
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
async function setMeta(
  meta: MetaTagBuilder,
  row: LinkRow,
  seller: UserRow,
  host: string,
  customDomainUrl: string | null,
  covers: CoverMeta[] = [],
) {
  await setHostMeta(meta, seller as unknown as User);
  meta.set({ title: row.name });
  const html = htmlSafeDescription(row.description);
  const description = snippetTruncate(
    present(row.description) ? plaintextDescription(row.description) : "Available on Gumroad",
  );
  const onOwnCustomDomain = (await customDomainByHost(host))?.user_id === row.user_id;
  const canonicalUrl = longUrl(row, seller, {
    host: onOwnCustomDomain && customDomainUrl ? customDomainUrl.replace(/\/$/u, "") : null,
  });

  meta.set({ name: "description", content: description });
  meta.set({ property: "gr:page:type", content: "product" });
  meta.set({ property: "product:retailer_item_id", content: row.unique_permalink });
  const priceCents = await minimumOfferPriceCents(row);
  const currency = row.price_currency_type;
  // The price meta tags come from `product.price_cents`, which is nil for a product without a live price.
  const pagePrice = await pagePriceCents(row);
  if (pagePrice !== null && present(currency)) {
    // (price_cents / unit_scaling_factor(currency).to_f).round(2)
    meta.set({
      property: "product:price:amount",
      content: Math.round((pagePrice / unitScalingFactor(currency)) * 100) / 100,
    });
    meta.set({ property: "product:price:currency", content: currency.toUpperCase() });
  }
  meta.set({ property: "og:title", content: row.name });
  meta.set({ property: "og:description", content: description });
  meta.set({ property: "og:url", content: canonicalUrl });
  // Link#social_share_image: the first cover's URL when it is an Unsplash photo or an uploaded image (`preview_image_path?`), else an oEmbed cover's
  // thumbnail escaped by Addressable, else nothing (an uploaded video's poster is the only other source, and uploads stay with Rails).
  const main = covers[0];
  const photo = main?.type === "unsplash" || main?.type === "image";
  const oembed = main?.type === "oembed";
  const shareImage = photo
    ? main.url
    : oembed && present(main.thumbnail ?? "")
      ? addressableEscape(main.thumbnail!)
      : null;
  if (present(shareImage ?? "")) {
    meta.set({ property: "og:image", content: shareImage });
    meta.set({ property: "og:image:alt", content: "" });
  }
  meta.set({ property: "og:type", content: ":product" });
  meta.set({ property: "twitter:title", content: row.name });
  if (photo) {
    meta.set({ property: "twitter:card", content: "summary_large_image" });
    meta.set({ property: "twitter:image", content: main.url });
    meta.set({ property: "twitter:image:alt", content: "" });
  } else if (oembed) {
    // A cover without a thumbnail or a player sets a nil content, which the serialized tag leaves out.
    meta.set({ property: "twitter:card", content: "player" });
    meta.set({ property: "twitter:image", content: main.thumbnail });
    meta.set({ property: "twitter:player", content: main.url });
    meta.set({ property: "twitter:player:width", content: main.native_width });
    meta.set({ property: "twitter:player:height", content: main.native_height });
  } else {
    meta.set({ property: "twitter:card", content: "summary" });
  }
  meta.set({ property: "twitter:domain", content: "Gumroad" });
  meta.set({
    property: "twitter:description",
    content: description.length > 200 ? `${description.slice(0, 197)}...` : description,
  });
  if (present(seller.twitter_handle as string))
    meta.set({ property: "twitter:creator", content: `@${seller.twitter_handle}` });
  // `display_asset_previews.select { |asset| asset.file.image? }`: only an uploaded image, never an Unsplash photo or an oEmbed cover.
  for (const cover of covers)
    if (cover.type === "image") meta.set({ tag_name: "link", rel: "preload", as: "image", href: cover.url });
  // The page imports the calendar after it mounts; only call products show one, so only they preload it.
  if (row.native_type === "call")
    meta.set({
      tag_name: "link",
      rel: "modulepreload",
      crossorigin: "anonymous",
      href: viteAssetPath("components/ui/Calendar.tsx"),
      head_key: "call-calendar",
    });
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
  const { priceCurrency, price } = offerPrice(currency, priceCents, await usdOfferPriceCents(currency, priceCents));
  const offer: Record<string, unknown> = { "@type": "Offer", priceCurrency, availability, url: canonicalUrl };
  if (price !== undefined) offer.price = price;
  const offers = Object.fromEntries(Object.entries(offer).filter(([, value]) => value !== undefined));
  const data: Record<string, unknown> =
    row.native_type === "ebook"
      ? ebookStructuredData({
          name: row.name,
          authorName: seller.name,
          description: structuredDescription,
          url: canonicalUrl,
          image: shareImage,
          sku: row.unique_permalink,
          workExamples: bookWorkExamples(row.name, await bookFiles(row)),
          offers,
        })
      : {
          "@context": "https://schema.org",
          "@type": "Product",
          name: row.name,
          description: structuredDescription,
          url: canonicalUrl,
          image: shareImage,
          sku: row.unique_permalink,
          brand: present(seller.name) ? { "@type": "Brand", name: seller.name } : null,
          offers,
        };
  if (displaysReviews && stats.count > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Math.round(stats.average * 10) / 10,
      reviewCount: stats.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  meta.set({
    tag_name: "script",
    type: "application/ld+json",
    inner_content: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null)),
    head_key: "structured-data",
  });

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
    meta.set({
      tag_name: "link",
      rel: "preload",
      href: `${assetHost(domainConfig(process.env)) ?? ""}/fonts/ABCFavorit-Regular.woff2`,
      as: "font",
      type: "font/woff2",
      crossorigin: "anonymous",
      head_key: "default_font_preload",
    });
  }
  await setFaviconMetaTags(meta, seller as unknown as User);
}

// Product::StructuredData#usd_offer_price_cents: the price in USD from the cached rate, null when there is no price or rate.
export async function usdOfferPriceCents(currency: string | null, cents: number | null): Promise<number | null> {
  if (cents === null) return null;
  if ((currency ?? "") === "usd") return cents;
  try {
    const rate = await cachedRate(currency ?? "");
    if (rate === null || rubyStringToF(rate) <= 0) return null;
    return await getUsdCents(currency ?? "", cents, rubyStringToF(rate));
  } catch {
    return null;
  }
}

// Product::StructuredData#build_offer_data: a USD amount when the conversion worked, else the product's own currency
// and amount; a blank currency drops both.
export function offerPrice(
  currency: string | null,
  priceCents: number | null,
  usdCents: number | null,
): { priceCurrency: string | undefined; price: number | undefined } {
  const displayCents = usdCents ?? priceCents;
  const code = usdCents === null ? (currency ?? "").toUpperCase() : "USD";
  if (!present(code)) return { priceCurrency: undefined, price: undefined };
  return { priceCurrency: code, price: displayCents === null ? undefined : displayCents / unitScalingFactor(code) };
}

export type BookFile = { filetype: string | null; isbn: string | null };

// The alive files that `supports_isbn?` (epub, pdf, mobi), in `position` order; MySQL sorts a NULL position first.
async function bookFiles(row: LinkRow): Promise<BookFile[]> {
  return selectRows<BookFile>(
    Prisma.sql`SELECT ${column("product_files", "filetype")}, ${column("product_files", "isbn")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${row.id} AND ${column("product_files", "deleted_at")} IS NULL AND ${column("product_files", "filetype")} IN ('epub', 'pdf', 'mobi') ORDER BY ${column("product_files", "position")} ASC, ${column("product_files", "id")} ASC`,
  );
}

// Product::StructuredData#build_book_work_examples
export function bookWorkExamples(name: string | null, files: BookFile[]): Record<string, unknown>[] {
  return files.map((file) => {
    const example: Record<string, unknown> = {
      "@type": "Book",
      bookFormat: "EBook",
      name: `${name} (${(file.filetype ?? "").toUpperCase()})`,
    };
    if (present(file.isbn)) example.isbn = file.isbn;
    return example;
  });
}

// Product::StructuredData#build_ebook_structured_data. An unnamed seller leaves `author.name` as null, which Rails' compact keeps.
export function ebookStructuredData(input: {
  name: string | null;
  authorName: string | null;
  description: string | null;
  url: string;
  image?: string | null;
  sku: string | null;
  workExamples: Record<string, unknown>[];
  offers: Record<string, unknown>;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: input.name,
    author: { "@type": "Person", name: input.authorName },
    description: input.description,
    url: input.url,
    // Link#social_share_image.presence
    ...(input.image !== undefined ? { image: input.image } : {}),
    sku: input.sku,
  };
  if (input.workExamples.length > 0) data.workExample = input.workExamples;
  data.offers = input.offers;
  return data;
}

async function customSummary(row: LinkRow): Promise<string | null> {
  const value = jsonData(row).custom_summary;
  return typeof value === "string" && present(value) ? value : null;
}

// Link#price_cents (Product::Prices#default_price_cents)
async function pagePriceCents(row: LinkRow): Promise<number | null> {
  const prices = await selectRows<{
    price_cents: number;
    recurrence: string | null;
    currency: string | null;
    flags: number;
  }>(
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
  if (((BigInt(row.flags as bigint | number) >> 1n) & 1n) === 1n && duration)
    relevant = relevant.filter((price) => price.recurrence === duration);
  return relevant.at(-1)?.price_cents ?? null;
}

function guidOf(cookieHeader: string | null): string | null {
  const match = new RegExp(`(?:^|;\\s*)${GUID_COOKIE}=([^;]*)`, "u").exec(cookieHeader ?? "");
  return match?.[1] && match[1] !== "" ? decodeURIComponent(match[1]) : null;
}

// The editor's extras: the seller's live, unarchived products, the posts a section could show and the wishlists.
// A seller's wishlists are handed back in productProps, so none reach here.
async function editingProps(seller: UserRow) {
  const archived = 1 << 4;
  const products = await selectRows<{ id: bigint; name: string | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND (${column("links", "flags")} & ${archived}) = 0 ORDER BY ${column("links", "id")} ASC`,
  );
  return {
    products: products.map((product) => ({ id: encrypt(product.id), name: product.name })),
    posts: await visiblePosts(seller),
    wishlist_options: [],
  };
}

// `@product.taxonomy&.ancestry_path&.join("/")` (closure_tree: the root first, the taxonomy itself last)
async function taxonomyPath(row: LinkRow): Promise<string | null> {
  if (row.taxonomy_id === null || row.taxonomy_id === undefined) return null;
  const slugs = await selectRows<{ slug: string }>(
    Prisma.sql`SELECT ${column("taxonomies", "slug")} FROM ${table("taxonomy_hierarchies")} INNER JOIN ${table("taxonomies")} ON ${column("taxonomies", "id")} = ${column("taxonomy_hierarchies", "ancestor_id")} WHERE ${column("taxonomy_hierarchies", "descendant_id")} = ${row.taxonomy_id as bigint} ORDER BY ${column("taxonomy_hierarchies", "generations")} DESC`,
  );
  return slugs.length === 0 ? null : slugs.map((entry) => entry.slug).join("/");
}

async function build(
  row: LinkRow,
  seller: UserRow,
  viewer: ProductPageViewerInput,
  meta: MetaTagBuilder,
  host: string,
  kind: ProductPageKind = "show",
) {
  const props = await productProps(row, seller, viewer);
  await setMeta(
    meta,
    row,
    seller,
    host,
    viewer.sellerCustomDomainUrl,
    props.product.covers as CoverMeta[],
  );
  // ProductPresenter#iframe_product_props is product_props alone.
  if (kind === "iframe") return props;
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
  const page = {
    ...props,
    currency_code: viewer.user?.currency_type || "usd",
    show_ratings_filter: !!hasReviews,
    creator_profile: await creatorProfile(
      seller as unknown as Parameters<typeof creatorProfile>[0],
      !!viewer.context?.user && viewer.context.seller?.id === seller.id && settingsProfilePolicy.update(viewer.context),
    ),
    sections: [],
    main_section_index: Number(data?.main_section_index ?? 0) || 0,
    ...(editing ? await editingProps(seller) : {}),
  };
  // ProductPresenter#show_storefront_catalog?: a discover page keeps its own recommendation context and the seller keeps
  // the editing-shaped payload. The product has no sections of its own (handed back above).
  if (storefrontEnabled(seller) && kind !== "discover" && !editing) {
    const visitor = await visitorSearchParams(viewer.queryString ?? "");
    return {
      ...page,
      sections: await storefrontCatalogSections(seller as unknown as User, row, viewer.request, visitor),
      main_section_index: 0,
    };
  }
  if (kind !== "discover") return page;
  // The navigation lists the visitor's curated products first; the port answers only the case where there are none.
  if (await hasCuratedProductSources(viewer.user, viewer.browserGuid))
    throw new NotPortedError("curated products for the discover navigation");
  return { ...page, taxonomy_path: await taxonomyPath(row), taxonomies_for_nav: await taxonomiesForNav() };
}

// The click-through of a Discover result is attributed to the clicked product's own category, not the browsed one.
async function recordDiscoverClick(chain: Chain, product: LinkRow, query: Query): Promise<void> {
  const { request } = chain;
  await createDiscoverSearch(
    {
      query: typeof query.query === "string" ? query.query : null,
      taxonomyId: product.taxonomy_id as bigint | null,
      autocomplete: query.autocomplete === "true",
      clickedResource: { type: "Link", id: product.id },
    },
    {
      path: request.path,
      queryString: request.queryString,
      method: request.method,
      headers: request.headers,
      host: request.host,
      hostWithPort: request.hostWithPort,
      protocol: request.protocol,
      remoteIp: remoteIp(request.headers) ?? "127.0.0.1",
      cookies: new Map(),
      guid: request.cookies.get(GUID_COOKIE) ?? null,
      currentSellerId: null,
    },
    railsLoggedInUser(chain.auth.context),
    query,
  );
}

export async function assertRenderable(context: RenderContext): Promise<{ storefrontWrapped: boolean }> {
  const { chain, product, seller, query, code } = context;
  for (const name of UNSUPPORTED_PARAMS) if (name in query) throw new HandBackToRails();
  // A layout that is not text (`layout[]=x`) matches no branch in Rails but reaches the bundle links as a hash or list.
  if ("layout" in query && typeof query.layout !== "string") throw new HandBackToRails();
  const discoverRecommended =
    typeof query.recommended_by === "string" && DISCOVER_RECOMMENDERS.includes(query.recommended_by);
  let storefrontWrapped = false;
  try {
    const user = railsLoggedInUser(chain.auth.context);
    const viewer = viewerOf(
      query,
      code,
      user,
      user ? await loadSellerContext(chain.auth.context) : null,
      remoteIp(chain.request.headers),
      chain.request.cookies.get(GUID_COOKIE) ?? null,
      sellerCustomDomainUrl(context.isUserCustomDomain, chain.request.hostWithPort),
      chain.request,
    );
    storefrontWrapped = isStorefrontWrapped(seller, viewer);
    await build(
      product,
      seller,
      { ...viewer, queryString: chain.request.queryString },
      new (await import("../page-props/meta-tags.ts")).MetaTagBuilder(),
      chain.request.host,
      productPageKind(query, storefrontWrapped),
    );
    // create_discover_search!(clicked_resource: @product, ...) comes before the noindex header and the render.
    if (discoverRecommended) await recordDiscoverClick(chain, product, query);
    // set_noindex_header if !@product.alive?
    if (product.purchase_disabled_at !== null || product.banned_at !== null || product.deleted_at !== null)
      chain.headers.set("x-robots-tag", "noindex");
  } catch (error) {
    if (error instanceof NotPortedError) {
      if (process.env.PRODUCT_PAGE_DEBUG) console.error(`product page handed back: ${error.message}`);
      throw new HandBackToRails();
    }
    throw error;
  }
  return { storefrontWrapped };
}

// The tags a before_action leaves on a response that renders no product (the discover layout's autocomplete partial).
async function setProductPageMeta(
  meta: MetaTagBuilder,
  row: LinkRow,
  seller: UserRow,
  host: string,
  customDomainUrl: string | null,
) {
  await setMeta(meta, row, seller, host, customDomainUrl, (await coverProps(row)).covers as CoverMeta[]);
}

export { build as buildProductPage, guidOf, setProductPageMeta, viewerOf };
