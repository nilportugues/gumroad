// LinksController#show: the public product page. The filters run in Rails' order (fetch_product_for_show,
// check_banned, ensure_seller_is_not_deleted, set_x_robots_tag_header, set_affiliate_cookie,
// check_if_needs_redirect, ensure_domain_belongs_to_seller, render_custom_html_if_present) and halt with the
// redirect or 404 Rails sends. A request that would render goes to `renderable()`, which hands it back to
// Rails unless the port can prove the whole page (see presenters/product-page.ts).
import { Prisma } from "@prisma/client";

import { classifyHost } from "../../lib/navigation/proxy/hosts.ts";
import { decryptNumeric, encrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";
import { type LinkRow, customDomainByHost, findLink, findUserById, userByDomain, type UserRow } from "../presenters/product-reads.ts";
import { linkFields, longUrl, subdomainWithProtocol } from "../presenters/product.ts";
import { assertRenderable } from "../presenters/product-page.ts";
import { type ActionOptions, allDomain, type Chain, type FilterOutcome, HandBackToRails, RoutingError } from "./application-controller.ts";
import { parseQuery, toQuery, type Query } from "./rails-query.ts";
import { assertFlatQuery } from "./rails-params.ts";
import { setCookieHeader } from "./rack-cookies.ts";

const AFFILIATE_COOKIE_NAME_PREFIX = "_gumroad_affiliate_id_";
// Affiliate::AFFILIATE_COOKIE_LIFETIME_DAYS
const AFFILIATE_COOKIE_LIFETIME_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHOW_PATH = /^\/l\/([^/.?]+)(?:\/([^/.?]+))?$/;
const COFFEE_PATH = "/coffee";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

// String#to_i
const rubyToI = (value: string) => {
  const match = /^\s*[+-]?\d+(?:_\d+)*/.exec(value);
  return match ? Number(match[0].replaceAll("_", "")) : 0;
};

// Link.fetch_leniently(general_permalink, user:)
export async function fetchLeniently(permalink: string, userId: bigint | null): Promise<LinkRow | null> {
  const byUser = userId === null ? Prisma.sql`1 = 1` : Prisma.sql`${column("links", "user_id")} = ${userId}`;
  const visible = Prisma.sql`${column("links", "deleted_at")} IS NULL`;
  const [live] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${byUser} AND ${visible} AND (unique_permalink = ${permalink} OR custom_permalink = ${permalink}) ORDER BY ${column("links", "created_at")} ASC, ${column("links", "id")} ASC LIMIT 1`,
  );
  if (live) return live;

  const [legacy] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${byUser} AND ${visible} AND ${column("links", "id")} IN (SELECT ${column("legacy_permalinks", "product_id")} FROM ${table("legacy_permalinks")} WHERE ${column("legacy_permalinks", "permalink")} = ${permalink}) LIMIT 1`,
  );
  if (legacy || userId === null) return legacy ?? null;

  // A seller-scoped row fills collisions the global legacy table cannot represent.
  const [redirected] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${byUser} AND ${visible} AND ${column("links", "id")} IN (SELECT ${column("product_permalink_redirects", "product_id")} FROM ${table("product_permalink_redirects")} WHERE ${column("product_permalink_redirects", "seller_id")} = ${userId} AND ${column("product_permalink_redirects", "permalink")} = ${permalink}) LIMIT 1`,
  );
  return redirected ?? null;
}

// The affiliate id of ?affiliate_id= or ?a=, which AffiliateQueryParams reads as a scalar.
function affiliateIdParam(query: Query): number | null {
  const first = (value: string | string[] | Query | undefined) => (typeof value === "string" && value !== "" ? value : undefined);
  const raw = first(query.affiliate_id) ?? first(query.a);
  if (raw === undefined) return null;
  const id = rubyToI(raw);
  return id === 0 ? null : id;
}

type AffiliateRow = { id: bigint; type: string | null; deleted_at: Date | null; seller_id: bigint | null; affiliate_user_id: bigint | null };

const affiliateColumns = ["id", "type", "deleted_at", "seller_id", "affiliate_user_id"].map((name) => column("affiliates", name));

// AffiliateCookie#set_affiliate_cookie
async function setAffiliateCookie(chain: Chain, query: Query): Promise<void> {
  const externalId = affiliateIdParam(query);
  if (externalId === null) return;
  // Affiliate.find_by_external_id_numeric
  let id: number;
  try {
    id = decryptNumeric(externalId);
  } catch {
    return;
  }
  const [found] = await selectRows<AffiliateRow>(Prisma.sql`SELECT ${Prisma.join(affiliateColumns)} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${id} LIMIT 1`);
  if (!found) return;
  let affiliate = found;
  // A deleted account of the seller is replaced by the affiliate user's latest alive direct one.
  if (affiliate.type !== "GlobalAffiliate" && affiliate.deleted_at !== null) {
    const [replacement] = await selectRows<AffiliateRow>(
      Prisma.sql`SELECT ${Prisma.join(affiliateColumns)} FROM ${table("affiliates")} WHERE ${column("affiliates", "affiliate_user_id")} = ${affiliate.affiliate_user_id} AND ${column("affiliates", "seller_id")} = ${affiliate.seller_id} AND ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "deleted_at")} IS NULL ORDER BY ${column("affiliates", "id")} DESC LIMIT 1`,
    );
    if (!replacement) return;
    affiliate = replacement;
  }
  if (affiliate.deleted_at !== null) return;
  // Only GlobalAffiliate and DirectAffiliate define cookie_lifetime.
  if (affiliate.type !== "GlobalAffiliate" && affiliate.type !== "DirectAffiliate") throw new HandBackToRails();
  chain.cookies.push(
    setCookieHeader(`${AFFILIATE_COOKIE_NAME_PREFIX}${encrypt(affiliate.id, { padding: false })}`, {
      value: String(Math.floor(chain.now.getTime() / 1000)),
      domain: allDomain(chain.request.host),
      path: "/",
      expires: new Date(chain.now.getTime() + AFFILIATE_COOKIE_LIFETIME_DAYS * DAY_MS),
      httpOnly: true,
      sameSite: "lax",
    }),
  );
}

// url_for adds DOMAIN's port to a host given without one; production has none.
function withDefaultPort(host: string): string {
  const port = /:(\d+)$/.exec(domainConfig(process.env).domain)?.[1];
  return port && !/:\d+$/.test(host) ? `${host}:${port}` : host;
}

async function pageExists(productId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'Link' AND ${column("pages", "pageable_id")} = ${productId} AND ${column("pages", "custom_html")} IS NOT NULL AND TRIM(${column("pages", "custom_html")}) <> '' LIMIT 1`,
  );
  return rows.length > 0;
}

// Journey::Router::Utils.escape_segment: unreserved characters and sub-delimiters stay.
const escapeSegment = (value: string) => encodeURIComponent(value).replace(/%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

function queryString(options: Record<string, string>): string {
  const parts = toQuery(options);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export type ShownProduct = {
  product: LinkRow;
  seller: UserRow;
  productByCustomDomain: LinkRow | null;
  isUserCustomDomain: boolean;
  domainSeller: UserRow | null;
};

// LinksController#fetch_product_for_show: the product of the custom domain the request came in on, else the `:id` permalink within the
// seller the host names. Raises the 404 of an unknown product.
export async function fetchProductForShow(requestHost: string, id: string | null): Promise<ShownProduct> {
  const config = domainConfig(process.env);
  const host = classifyHost(requestHost, config);
  const custom = await customDomainByHost(requestHost);
  const customProduct = custom?.product_id != null ? await findLink(custom.product_id) : null;
  let productByCustomDomain: LinkRow | null = null;
  if (customProduct && present(linkFields.generalPermalink(customProduct))) {
    productByCustomDomain = await fetchLeniently(linkFields.generalPermalink(customProduct)!, customProduct.user_id);
  }
  // UserCustomDomainRequestService.valid?
  const isUserCustomDomain = !host.gumroad && requestHost !== config.validDiscoverRequestHost && customProduct === null;
  const domainSeller = await userByDomain(requestHost);

  let product = productByCustomDomain;
  if (product === null) {
    if (!present(id)) throw new RoutingError("Not Found");
    product = await fetchLeniently(id, domainSeller?.id ?? null);
    if (product === null) throw new RoutingError("Not Found");
  }
  const seller = (await findUserById(product.user_id!))!;
  return { product, seller, productByCustomDomain, isUserCustomDomain, domainSeller };
}

export async function productPageFilters(chain: Chain): Promise<FilterOutcome> {
  const { request } = chain;
  // Nested params and an explicit format change what `params` holds; Rails serves them.
  assertFlatQuery(request.queryString);
  const query = parseQuery(request.queryString);
  if ("format" in query) throw new HandBackToRails();

  const config = domainConfig(process.env);
  const path = SHOW_PATH.exec(request.path);
  const id = path ? decodeURIComponent(path[1]!) : null;
  const pathCode = path?.[2] ? decodeURIComponent(path[2]) : null;
  const queryCode = typeof query.code === "string" ? query.code : null;
  if (query.code !== undefined && typeof query.code !== "string") throw new HandBackToRails();
  const code = present(pathCode) ? pathCode : present(queryCode) ? queryCode : null;

  const { product, seller, productByCustomDomain, isUserCustomDomain, domainSeller } = await fetchProductForShow(request.host, id);

  // check_banned, ensure_seller_is_not_deleted
  if (product.banned_at !== null) throw new RoutingError("Not Found");
  if (seller.deleted_at !== null) throw new RoutingError("Not Found");
  // set_x_robots_tag_header
  if (present(code)) chain.headers.set("x-robots-tag", "noindex");
  // set_affiliate_cookie
  await setAffiliateCookie(chain, query);

  // check_if_needs_redirect
  if (productByCustomDomain === null) {
    const subdomain = subdomainWithProtocol(seller);
    const targetHost = !isUserCustomDomain && present(subdomain) ? subdomain : request.host;
    const permalink = linkFields.generalPermalink(product)!;
    if (targetHost !== request.host || permalink !== id) {
      const base = /^https?:\/\//.test(targetHost) ? targetHost : `${config.protocol}://${withDefaultPort(targetHost)}`;
      // short_link_offer_code_url when params[:code] is present (path or query), else short_link_url; the raw
      // query string rides along unchanged.
      const location = `${base}/l/${escapeSegment(permalink)}${present(code) ? `/${escapeSegment(code)}` : ""}${request.queryString === "" ? "" : `?${request.queryString}`}`;
      return { halt: { status: 301, location, rescued: true } };
    }
  }

  // ensure_domain_belongs_to_seller
  if (isUserCustomDomain && product.user_id !== domainSeller?.id) throw new RoutingError("Not Found");
  // render_custom_html_if_present
  if (await pageExists(product.id)) throw new HandBackToRails();

  // The action: a coffee product has its own page.
  if (product.native_type === "coffee") {
    const forwarded: Record<string, string> = {};
    for (const name of ["wanted", "native"]) if (typeof query[name] === "string") forwarded[name] = query[name] as string;
    return { halt: { status: 302, location: `${request.protocol}${request.hostWithPort}${COFFEE_PATH}${queryString(forwarded)}` } };
  }

  await assertRenderable({ chain, product, seller, query, code, isUserCustomDomain });
  return { state: { product_id: String(product.id), user_custom_domain: isUserCustomDomain ? "1" : "" } };
}

export const PRODUCT_PAGE_OPTIONS: ActionOptions = { filters: productPageFilters };
export type { UserRow };
export { longUrl };
