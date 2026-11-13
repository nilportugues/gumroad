// Port of Pages::ProfileData.build (app/services/pages/profile_data.rb) for a seller whose posts and reputation summary are not listed:
// the profile's tab names, the live products and the totals. A product is listed when it needs nothing the port cannot reproduce: no
// thumbnail and no cover (their URLs are signed CDN ones), a USD buy-only price and a description that sanitizes to itself. A published
// post (its URL on the store host) or the reputation summary (its cache signature) is Rails'.
//
// Rails.cache is not read or written: the payload is rebuilt each time. Ruby's cache key moves with the products, the visible posts,
// the profile and the reputation version, so a hit and a rebuild agree for as long as the entry lives.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { LinkFlags } from "../models/link.ts";
import { selectRows } from "../models/sql.ts";
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

const MAX_ITEMS = 100;
const DESCRIPTION_LIMIT = 200;
const TRUNCATION_OMISSION = "...";
// More live products than this are not read: Ruby lists the newest MAX_ITEMS and the rest is a count, but loading every row to count them
// is the work the replica should not do on a public page.
const MAX_PRODUCTS_READ = 1000;

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
  // Installments of the seller that are not deleted and have a publish time: a superset of `visible_on_profile`.
  publishedPosts: number;
  reputationSummaryEnabled: boolean;
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

// ActionView::Base.full_sanitizer.sanitize(text).squish.truncate(DESCRIPTION_LIMIT). Text with markup, entities or control characters
// would go through the HTML parser, which the port does not reimplement.
function listedDescription(description: string | null): string {
  const text = description ?? "";
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  if (/[<>&\u0000-\u0008\u000e-\u001f\u007f]/u.test(text))
    throw new NotPortedError("Pages::ProfileData sanitizing a product description with markup or control characters");
  const squished = text.replace(SPACES, " ").replace(/^ | $/gu, "");
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

// ERB::Util.json_escape(Pages::ProfileData.build(seller).to_json)
export function profileDataJson(facts: ProfileDataFacts): string {
  if (facts.publishedPosts > 0) throw new NotPortedError("Pages::ProfileData listing posts");
  if (facts.reputationSummaryEnabled)
    throw new NotPortedError("Pages::ProfileData reading the seller's reputation summary");
  const payload = {
    products: facts.products.map((product) => ({
      name: product.name,
      url: product.url,
      price: product.price,
      native_type: product.native_type,
      thumbnail_url: null,
      cover_url: null,
      description: listedDescription(product.description),
    })),
    posts: [],
    pages: tabNames(facts.sellerProfileJsonData).map((name) => ({ name })),
    products_total: facts.productsTotal,
    posts_total: 0,
  };
  return jsonEscape(JSON.stringify(payload));
}

// `seller.products.alive.not_archived.not_draft` as the payload reads it. A product the port cannot reproduce hands the page back.
async function loadProducts(
  seller: HostSeller,
  storeHost: string | null,
): Promise<{ products: ProfileProduct[]; total: number }> {
  const rows = await db.link.findMany({
    where: { user_id: seller.id, deleted_at: null, banned_at: null, purchase_disabled_at: null, draft: false },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: MAX_PRODUCTS_READ + 1,
  });
  if (rows.length > MAX_PRODUCTS_READ) throw new NotPortedError("Pages::ProfileData counting a very large catalogue");
  const live = rows.filter((row) => !LinkFlags.isSet(row.flags, "archived"));
  const listed = live.slice(0, MAX_ITEMS);
  if (listed.length === 0) return { products: [], total: live.length };
  if (storeHost === null)
    throw new NotPortedError("Pages::ProfileData listing products of a seller without a store host");

  const data = await loadRowData(listed);
  if (data.thumbnails.size > 0) throw new NotPortedError("Pages::ProfileData listing a product with a thumbnail");
  const previews = await selectRows(
    Prisma.sql`SELECT 1 FROM asset_previews WHERE deleted_at IS NULL AND link_id IN (${Prisma.join(listed.map((row) => row.id))}) LIMIT 1`,
  );
  if (previews.length > 0) throw new NotPortedError("Pages::ProfileData listing a product with a cover");
  const products = listed.map((row: LinkRow) => {
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
  return { products, total: live.length };
}

export async function loadProfileDataFacts(seller: HostSeller, now: Date): Promise<ProfileDataFacts> {
  const sellerId = seller.id;
  const { host: storeHost, refresh } = await storeHostWithProtocol(seller, now);
  const [{ products, total }, publishedPosts, profile, reputationSummaryEnabled] = await Promise.all([
    loadProducts(seller, storeHost),
    db.installment.count({ where: { seller_id: Number(sellerId), deleted_at: null, published_at: { not: null } } }),
    db.sellerProfile.findFirst({ where: { seller_id: sellerId }, orderBy: { id: "asc" } }),
    isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(sellerId))),
  ]);
  return {
    storeHost,
    routabilityRefresh: refresh,
    products,
    productsTotal: total,
    publishedPosts,
    reputationSummaryEnabled,
    sellerProfileJsonData: profile?.json_data ?? null,
  };
}
