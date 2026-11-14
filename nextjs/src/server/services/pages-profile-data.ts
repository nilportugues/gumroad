// Port of Pages::ProfileData.build (app/services/pages/profile_data.rb): the profile's tab names, the live products, the posts shown on
// the profile and the seller rating. A product is listed when it needs nothing the port cannot reproduce: no thumbnail and no cover
// (their URLs are signed CDN ones), a USD buy-only price and a description without control characters. Posts that share a publish time
// are Rails': the query has no tiebreaker, so their order is the database's.
//
// Rails.cache is not read or written: the payload is rebuilt each time. Ruby's cache key moves with the products, the visible posts,
// the profile and the reputation version, so a hit and a rebuild agree for as long as the entry lives.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { stripTags } from "../html/sanitizer.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { sellerReputationSummary, type ReputationSummary } from "../models/user-reputation-summary.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import {
  assertPriceSupported,
  loadRowData,
  priceFormattedVerbose,
  type LinkRow,
} from "../page-props/seller-products/listing.ts";
import { longUrl } from "../presenters/product.ts";

import { storeHostWithProtocol, type HostSeller } from "./custom-domain-hosts.ts";

const REPUTATION_SUMMARY_FEATURE = "seller_reputation_summary";

export const MAX_ITEMS = 100;
const DESCRIPTION_LIMIT = 200;
const TRUNCATION_OMISSION = "...";
// More live products than this are not read: Ruby lists the newest MAX_ITEMS and the rest is a count, but loading every row to count them
// is the work the replica should not do on a public page.
const MAX_PRODUCTS_READ = 1000;

// Installment#shown_on_profile, flag 8 of `installments.flags`
const SHOWN_ON_PROFILE_BIT = 1 << 7;
// A slug the post URL carries as it is; anything else would be percent-encoded.
const PLAIN_SLUG = /^[A-Za-z0-9_-]+$/u;

export type ProfilePost = { name: string | null; slug: string | null; publishedAt: Date };

export type ProfileProduct = {
  name: string;
  url: string;
  price: string;
  native_type: string;
  // Link#description as stored; sanitized when the payload is built.
  description: string | null;
};

export type ProfileDataFacts = {
  // User#store_host_with_protocol, and the CustomDomain id whose routability refresh reading it enqueues.
  storeHost: string | null;
  routabilityRefresh: number | null;
  // `products.alive.not_archived.not_draft` by `created_at DESC, id DESC`, the first MAX_ITEMS of them, and how many there are.
  products: ProfileProduct[];
  productsTotal: number;
  // `installments.visible_on_profile` by `published_at DESC`, the first MAX_ITEMS of them, and how many there are.
  posts: ProfilePost[];
  postsTotal: number;
  // `seller.seller_reputation_summary`; undefined while the flag is off, which leaves the key out of the payload.
  sellerRating: ReputationSummary | null | undefined;
  // SellerProfile#json_data, null when the seller has no profile row.
  sellerProfileJsonData: unknown;
};

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// String#present? of a Ruby string: Unicode white space only is blank.
const SPACES = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

// Pages::ProfileData.pages
function tabNames(jsonData: unknown): string[] {
  if (jsonData === null || jsonData === undefined) return [];
  if (!isHash(jsonData)) throw new NotPortedError("Pages::ProfileData reading a profile whose json_data is not a hash");
  const tabs = jsonData.tabs;
  if (tabs === null || tabs === undefined) return [];
  if (!Array.isArray(tabs)) throw new NotPortedError("Pages::ProfileData reading profile tabs that are not a list");
  const names: string[] = [];
  for (const tab of tabs) {
    if (!isHash(tab)) throw new NotPortedError("Pages::ProfileData reading a profile tab that is not a hash");
    const name = tab.name;
    if (name === null || name === undefined) continue;
    if (typeof name !== "string") throw new NotPortedError("Pages::ProfileData reading a tab name that is not text");
    if (!BLANK.test(name)) names.push(name);
  }
  return names;
}

// ActionView::Base.full_sanitizer.sanitize(text).squish.truncate(DESCRIPTION_LIMIT). Control characters are Rails': the libxml2 port
// in html/ has no golden for them.
function listedDescription(description: string | null): string {
  const text = description ?? "";
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(text))
    throw new NotPortedError("Pages::ProfileData sanitizing a product description with control characters");
  const squished = stripTags(text).replace(SPACES, " ").replace(/^ | $/gu, "");
  const characters = Array.from(squished);
  if (characters.length <= DESCRIPTION_LIMIT) return squished;
  return characters.slice(0, DESCRIPTION_LIMIT - TRUNCATION_OMISSION.length).join("") + TRUNCATION_OMISSION;
}

// ERB::Util.json_escape, which also covers what ActiveSupport's own JSON escaping writes.
const JSON_ESCAPES: Record<string, string> = {
  "&": "\\u0026",
  ">": "\\u003e",
  "<": "\\u003c",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};
export const jsonEscape = (json: string): string => json.replace(/[&><\u2028\u2029]/gu, (c) => JSON_ESCAPES[c]!);

// One entry of `Pages::ProfileData.products`, in the payload's key order.
export const profileProductEntries = (products: ProfileProduct[]) =>
  products.map((product) => ({
    name: product.name,
    url: product.url,
    price: product.price,
    native_type: product.native_type,
    thumbnail_url: null,
    cover_url: null,
    description: listedDescription(product.description),
  }));

// One entry of `Pages::ProfileData.posts`: Installment#full_url on the store host, null for a post with no slug.
function postEntries(facts: ProfileDataFacts) {
  return facts.posts.map((post) => {
    let url: string | null = null;
    if (post.slug !== null && post.slug !== "") {
      if (facts.storeHost === null)
        throw new NotPortedError("Pages::ProfileData listing posts of a seller without a store host");
      if (!PLAIN_SLUG.test(post.slug))
        throw new NotPortedError("Pages::ProfileData linking a post whose slug needs escaping");
      url = `${facts.storeHost}/p/${post.slug}`;
    }
    return { name: post.name, url, published_at: `${post.publishedAt.toISOString().slice(0, 19)}Z` };
  });
}

// Float#to_json keeps the fraction of a whole number ("5.0"), which JSON.stringify drops.
function sellerRatingJson(rating: ReputationSummary | null): string {
  if (rating === null) return "null";
  const average = Number.isInteger(rating.average) ? rating.average.toFixed(1) : String(rating.average);
  return `{"average":${average},"count":${rating.count},"products_count":${rating.products_count}}`;
}

// ERB::Util.json_escape(Pages::ProfileData.build(seller).to_json)
export function profileDataJson(facts: ProfileDataFacts): string {
  const payload = JSON.stringify({
    products: profileProductEntries(facts.products),
    posts: postEntries(facts),
    pages: tabNames(facts.sellerProfileJsonData).map((name) => ({ name })),
    products_total: facts.productsTotal,
    posts_total: facts.postsTotal,
  });
  const json =
    facts.sellerRating === undefined
      ? payload
      : `${payload.slice(0, -1)},"seller_rating":${sellerRatingJson(facts.sellerRating)}}`;
  return jsonEscape(json);
}

// `seller.products.alive.not_archived.not_draft` by `created_at DESC, id DESC`.
async function liveProducts(seller: HostSeller): Promise<LinkRow[]> {
  const rows = await db.link.findMany({
    where: { user_id: seller.id, deleted_at: null, banned_at: null, purchase_disabled_at: null, draft: false },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: MAX_PRODUCTS_READ + 1,
  });
  if (rows.length > MAX_PRODUCTS_READ) throw new NotPortedError("Pages::ProfileData counting a very large catalogue");
  return rows.filter((row) => !LinkFlags.isSet(row.flags, "archived"));
}

// The listed products as the payload reads them. A product the port cannot reproduce hands the page back.
async function describeProducts(listed: LinkRow[], storeHost: string | null): Promise<ProfileProduct[]> {
  if (listed.length === 0) return [];
  if (storeHost === null)
    throw new NotPortedError("Pages::ProfileData listing products of a seller without a store host");

  const data = await loadRowData(listed);
  if (data.thumbnails.size > 0) throw new NotPortedError("Pages::ProfileData listing a product with a thumbnail");
  const previews = await selectRows(
    Prisma.sql`SELECT 1 FROM asset_previews WHERE deleted_at IS NULL AND link_id IN (${Prisma.join(listed.map((row) => row.id))}) LIMIT 1`,
  );
  if (previews.length > 0) throw new NotPortedError("Pages::ProfileData listing a product with a cover");
  return listed.map((row: LinkRow) => {
    try {
      assertPriceSupported(row, data);
    } catch (error) {
      if (error instanceof HandBackToRails) throw new NotPortedError("Pages::ProfileData pricing this product");
      throw error;
    }
    return {
      name: row.name ?? "",
      // The seller is read only to default the host, which the store host replaces.
      url: longUrl(row, null as never, { host: storeHost }),
      price: priceFormattedVerbose(row, data),
      native_type: row.native_type,
      description: row.description,
    };
  });
}

// `seller.installments.visible_on_profile`: alive, published, audience, shown on the profile and outside a workflow.
async function loadPosts(seller: HostSeller): Promise<{ posts: ProfilePost[]; total: number }> {
  const visible = Prisma.sql`FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "installment_type")} = 'audience' AND ${column("installments", "workflow_id")} IS NULL AND (${column("installments", "flags")} & ${SHOWN_ON_PROFILE_BIT}) != 0`;
  const [rows, [count]] = await Promise.all([
    // One past MAX_ITEMS, so a tie across the cut shows up too.
    selectRows<{ name: string | null; slug: string | null; published_at: Date }>(
      Prisma.sql`SELECT name, slug, published_at ${visible} ORDER BY published_at DESC LIMIT ${MAX_ITEMS + 1}`,
    ),
    selectRows<{ total: bigint | number }>(Prisma.sql`SELECT COUNT(*) AS total ${visible}`),
  ]);
  if (new Set(rows.map((row) => row.published_at.getTime())).size !== rows.length)
    throw new NotPortedError("Pages::ProfileData ordering posts that share a publish time");
  return {
    posts: rows.slice(0, MAX_ITEMS).map((row) => ({ name: row.name, slug: row.slug, publishedAt: row.published_at })),
    total: Number(count?.total ?? 0),
  };
}

async function loadProducts(
  seller: HostSeller,
  storeHost: string | null,
): Promise<{ products: ProfileProduct[]; total: number }> {
  const live = await liveProducts(seller);
  return { products: await describeProducts(live.slice(0, MAX_ITEMS), storeHost), total: live.length };
}

// Pages::ProfileData.products_page for the gumroad:products bridge. Null when `offset` is past the count, which the controller
// answers before it touches the store host.
export async function loadProductsSlice(
  seller: HostSeller,
  now: Date,
  window: { offset: bigint; limit: number },
): Promise<{ products: ProfileProduct[]; total: number; routabilityRefresh: number | null } | null> {
  const live = await liveProducts(seller);
  if (window.offset > BigInt(live.length)) return null;
  const { host: storeHost, refresh } = await storeHostWithProtocol(seller, now);
  const offset = Number(window.offset);
  const products = await describeProducts(live.slice(offset, offset + window.limit), storeHost);
  return { products, total: live.length, routabilityRefresh: refresh };
}

export async function loadProfileDataFacts(seller: HostSeller, now: Date): Promise<ProfileDataFacts> {
  const sellerId = seller.id;
  const { host: storeHost, refresh } = await storeHostWithProtocol(seller, now);
  const [{ products, total }, { posts, total: postsTotal }, profile, reputationSummaryEnabled] = await Promise.all([
    loadProducts(seller, storeHost),
    loadPosts(seller),
    db.sellerProfile.findFirst({ where: { seller_id: sellerId }, orderBy: { id: "asc" } }),
    isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(sellerId))),
  ]);
  return {
    storeHost,
    routabilityRefresh: refresh,
    products,
    productsTotal: total,
    posts,
    postsTotal,
    sellerRating: reputationSummaryEnabled ? await sellerReputationSummary(sellerId) : undefined,
    sellerProfileJsonData: profile?.json_data ?? null,
  };
}
