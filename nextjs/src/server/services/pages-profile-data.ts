// Port of Pages::ProfileData.build (app/services/pages/profile_data.rb) for a seller whose storefront has nothing to list, which is the
// payload with empty `products` and `posts` and the profile's tab names. A seller with a product (even an archived or draft one: the
// scope is narrowed in Ruby), a published post or the reputation summary is Rails': listing a product needs its formatted price, cover
// and thumbnail URLs and a squished description, a post its URL on the store host, the summary its cache signature.
//
// Rails.cache is not read or written: the payload is rebuilt each time. Ruby's cache key moves with the products, the visible posts,
// the profile and the reputation version, so a hit and a rebuild agree for as long as the entry lives.
import { db } from "../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

const REPUTATION_SUMMARY_FEATURE = "seller_reputation_summary";

export type ProfileDataFacts = {
  // Links of the seller that are not deleted: a superset of `products.alive.not_archived.not_draft`.
  undeletedProducts: number;
  // Installments of the seller that are not deleted and have a publish time: a superset of `visible_on_profile`.
  publishedPosts: number;
  reputationSummaryEnabled: boolean;
  // SellerProfile#json_data, null when the seller has no profile row.
  sellerProfileJsonData: unknown;
};

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// String#present? of a Ruby string: Unicode white space only is blank.
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
  if (facts.undeletedProducts > 0) throw new NotPortedError("Pages::ProfileData listing products");
  if (facts.publishedPosts > 0) throw new NotPortedError("Pages::ProfileData listing posts");
  if (facts.reputationSummaryEnabled)
    throw new NotPortedError("Pages::ProfileData reading the seller's reputation summary");
  const payload = {
    products: [],
    posts: [],
    pages: tabNames(facts.sellerProfileJsonData).map((name) => ({ name })),
    products_total: 0,
    posts_total: 0,
  };
  return jsonEscape(JSON.stringify(payload));
}

export async function loadProfileDataFacts(sellerId: bigint): Promise<ProfileDataFacts> {
  const [undeletedProducts, publishedPosts, profile, reputationSummaryEnabled] = await Promise.all([
    db.link.count({ where: { user_id: sellerId, deleted_at: null } }),
    db.installment.count({ where: { seller_id: Number(sellerId), deleted_at: null, published_at: { not: null } } }),
    db.sellerProfile.findFirst({ where: { seller_id: sellerId }, orderBy: { id: "asc" } }),
    isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(sellerId))),
  ]);
  return {
    undeletedProducts,
    publishedPosts,
    reputationSummaryEnabled,
    sellerProfileJsonData: profile?.json_data ?? null,
  };
}
