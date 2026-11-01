// AffiliateRedirectController#set_cookie_and_redirect (/a/:affiliate_id and /a/:affiliate_id/:unique_permalink): sets the
// affiliate cookie (AffiliateCookie#create_affiliate_id_cookie) and redirects to where the affiliate sends visitors.
import { Prisma } from "@prisma/client";

import { decryptNumeric, encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { PRODUCT_AFFILIATES } from "../models/product-affiliate.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";
import { longUrl, subdomainWithProtocol } from "../presenters/product.ts";
import { type LinkRow, type Row, type UserRow, findUserById } from "../presenters/product-reads.ts";
import { HandBackToRails, RoutingError, allDomain, processAction, type ActionResult } from "./application-controller.ts";
import { setCookieHeader } from "./rack-cookies.ts";
import type { RailsRequest } from "./rails-request.ts";

const AFFILIATE_COOKIE_NAME_PREFIX = "_gumroad_affiliate_id_";
const MAX_NUMERIC_ID = 2 ** 30 - 1;
const DAY_MS = 86_400_000;
const DIRECT_AFFILIATE_COOKIE_LIFETIME_DAYS = 30;
const GLOBAL_AFFILIATE_COOKIE_LIFETIME_DAYS = 7;
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const FOUND = 302;
const SHORT_QUERY_PARAM = "a";
const AFFILIATE_QUERY_PARAM = "affiliate_id";

type AffiliateRow = { id: bigint; seller_id: bigint | null; affiliate_user_id: bigint | null; deleted_at: Date | null; flags: number | bigint | null; destination_url: string | null; type: string };

// Ruby's String#to_i for the digits of a path segment; anything it would read as a bignum is Rails'.
function rubyToI(value: string): number {
  const match = /^\s*([+-]?\d[\d_]*)/u.exec(value);
  if (match === null) return 0;
  const digits = match[1]!.replaceAll("_", "");
  if (digits.replace(/^[+-]/u, "").length > 15) throw new HandBackToRails("an affiliate id beyond what a number holds");
  return Number(digits);
}

async function findAffiliate(id: number): Promise<AffiliateRow | null> {
  const [row] = await selectRows<AffiliateRow>(Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${id} LIMIT 1`);
  return row ?? null;
}

// `affiliate.affiliate_user.direct_affiliate_accounts.where(seller: affiliate.seller).alive.last`
async function lastAliveDirectAccount(affiliate: AffiliateRow): Promise<AffiliateRow | null> {
  const [row] = await selectRows<AffiliateRow>(
    Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "affiliate_user_id")} = ${affiliate.affiliate_user_id} AND ${column("affiliates", "seller_id")} = ${affiliate.seller_id} AND ${column("affiliates", "deleted_at")} IS NULL ORDER BY ${column("affiliates", "id")} DESC LIMIT 1`,
  );
  return row ?? null;
}

type CookieLifetime = typeof DIRECT_AFFILIATE_COOKIE_LIFETIME_DAYS | typeof GLOBAL_AFFILIATE_COOKIE_LIFETIME_DAYS;

function cookieLifetimeDays(affiliate: AffiliateRow): CookieLifetime {
  if (affiliate.type === "DirectAffiliate") return DIRECT_AFFILIATE_COOKIE_LIFETIME_DAYS;
  if (affiliate.type === "GlobalAffiliate") return GLOBAL_AFFILIATE_COOKIE_LIFETIME_DAYS;
  throw new HandBackToRails(`an affiliate of type ${affiliate.type}`);
}

// AffiliateCookie#create_affiliate_id_cookie: the cookie line, or null when the affiliate does not earn one.
async function affiliateCookie(request: RailsRequest, affiliate: AffiliateRow, now: Date): Promise<string | null> {
  let credited: AffiliateRow | null = affiliate;
  if (affiliate.type !== "GlobalAffiliate" && affiliate.deleted_at !== null) credited = await lastAliveDirectAccount(affiliate);
  if (credited === null || credited.deleted_at !== null) return null;
  const days = cookieLifetimeDays(credited);
  return setCookieHeader(`${AFFILIATE_COOKIE_NAME_PREFIX}${encrypt(credited.id, { padding: false })}`, {
    value: String(Math.floor(now.getTime() / 1000)),
    expires: new Date(now.getTime() + days * DAY_MS),
    httpOnly: true,
    domain: allDomain(request.host),
    path: "/",
    sameSite: "lax",
  });
}

// Addressable::URI.encode_component(value, CharacterClasses::UNRESERVED)
const encodeComponent = (value: Buffer): string =>
  Array.from(value)
    .map((byte) => (/[A-Za-z0-9\-._~]/u.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");

// Addressable::URI.unencode_component of a query component ("+" is a space; "%zz" stays as typed).
function unencodeComponent(value: string): Buffer {
  const bytes: number[] = [];
  const raw = Buffer.from(value.replaceAll("+", " "), "utf8");
  for (let index = 0; index < raw.length; index++) {
    const hex = raw.subarray(index + 1, index + 3).toString("latin1");
    if (raw[index] === 0x25 && /^[0-9a-fA-F]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(raw[index]!);
  }
  const buffer = Buffer.from(bytes);
  // A component that is not UTF-8 is a case Addressable's encoding rules are not ported for.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new HandBackToRails("a query component that is not UTF-8");
  }
  return buffer;
}

// Addressable::URI#query_values: a Hash in which the last of a repeated key wins; a key without "=" has a nil value.
function queryValues(query: string | undefined): Map<string, { key: Buffer; value: Buffer | null }> {
  const values = new Map<string, { key: Buffer; value: Buffer | null }>();
  if (query === undefined) return values;
  for (const pair of query.split("&")) {
    if (pair === "") throw new HandBackToRails("an empty query pair");
    const index = pair.indexOf("=");
    const key = unencodeComponent(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : unencodeComponent(pair.slice(index + 1));
    values.set(key.toString("latin1"), { key, value });
  }
  return values;
}

// The URLs sellers store as a destination, which Addressable parses without raising. Anything else is Rails'.
const DESTINATION = /^(?<before>(?:[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s/?#]*)?[^\s?#]*)(?:\?(?<query>[^\s#]*))?(?<fragment>#\S*)?$/u;

// host_relative: a path-relative destination is read as a path on this host.
function hostRelative(destination: string): string {
  if (destination === "" || /^([a-z][a-z\d\-+.]*:|\/\/)/iu.test(destination) || destination.startsWith("/") || destination.startsWith("?")) return destination;
  return `/${destination}`;
}

// redirect_url: the destination with the query of the destination and of this request merged (and sorted), as Addressable writes it.
export function mergeQueries(finalDestinationUrl: string, request: RailsRequest, affiliateId: string, destinationUrlPresent: boolean): string {
  const groups = DESTINATION.exec(hostRelative(finalDestinationUrl.trim()))?.groups;
  if (groups === undefined) throw new HandBackToRails("a destination url Addressable may reject");
  const merged = queryValues(groups.query);
  for (const [name, entry] of queryValues(request.queryString === "" ? undefined : request.queryString)) merged.set(name, entry);
  if (destinationUrlPresent) merged.set(AFFILIATE_QUERY_PARAM, { key: Buffer.from(AFFILIATE_QUERY_PARAM), value: Buffer.from(affiliateId) });
  if (merged.size === 0) return `${groups.before}${groups.query === undefined ? "" : `?${groups.query}`}${groups.fragment ?? ""}`;
  const query = [...merged.values()]
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map(({ key, value }) => (value === null ? encodeComponent(key) : `${encodeComponent(key)}=${encodeComponent(value)}`))
    .join("&");
  return `${groups.before}?${query}${groups.fragment ?? ""}`;
}

async function productsOf(affiliate: AffiliateRow): Promise<{ links: LinkRow[]; assignments: Row[] }> {
  const assignments = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${PRODUCT_AFFILIATES}\`.*`)} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${affiliate.id}`,
  );
  const links = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} INNER JOIN ${table(PRODUCT_AFFILIATES)} ON ${column("links", "id")} = ${column(PRODUCT_AFFILIATES, "link_id")} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${affiliate.id} ORDER BY ${column("links", "id")} DESC LIMIT 1`,
  );
  return { links, assignments };
}

async function sellerOf(link: LinkRow): Promise<UserRow> {
  const seller = link.user_id === null ? null : await findUserById(link.user_id);
  if (seller === null) throw new HandBackToRails("a product without a seller");
  return seller;
}

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// DirectAffiliate#final_destination_url and GlobalAffiliate#final_destination_url
async function finalDestinationUrl(affiliate: AffiliateRow, product: LinkRow | null): Promise<string> {
  if (affiliate.type === "GlobalAffiliate") {
    if (product !== null) return longUrl(product, await sellerOf(product));
    const config = domainConfig(process.env);
    return `${config.protocol}://${config.discoverDomain}/discover?${SHORT_QUERY_PARAM}=${encryptNumeric(Number(affiliate.id))}`;
  }
  if (affiliate.type !== "DirectAffiliate") throw new HandBackToRails(`an affiliate of type ${affiliate.type}`);

  const { links, assignments } = await productsOf(affiliate);
  const appliesToAll = (Number(affiliate.flags ?? 0) & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0;
  let chosen = product;
  if (!appliesToAll && assignments.length === 1) chosen = links[0] ?? null;
  const assignment = chosen === null ? undefined : assignments.find((row) => Number(row.link_id) === Number(chosen!.id));
  const productDestinationUrl = assignment?.destination_url as string | null | undefined;

  if (present(productDestinationUrl)) return productDestinationUrl;
  if (appliesToAll && present(affiliate.destination_url)) return affiliate.destination_url;
  if (assignment !== undefined) return longUrl(chosen!, await sellerOf(chosen!));
  const seller = affiliate.seller_id === null ? null : await findUserById(affiliate.seller_id);
  const profile = seller === null ? null : subdomainWithProtocol(seller);
  if (profile !== null) return profile;
  const fallback = links[0];
  if (fallback === undefined) throw new HandBackToRails("an affiliate without a destination");
  return longUrl(fallback, await sellerOf(fallback));
}

// `Affiliate.find_by_external_id_numeric(params[:affiliate_id].to_i)`; a missing affiliate is e404.
async function affiliateOf(segment: string): Promise<AffiliateRow> {
  const id = rubyToI(segment);
  if (id < 0 || id > MAX_NUMERIC_ID) throw new HandBackToRails("an affiliate id outside the obfuscated range");
  const affiliate = await findAffiliate(decryptNumeric(id));
  if (affiliate === null) throw new RoutingError("Not Found");
  return affiliate;
}

export function affiliateRedirectResponse(incoming: Request, params: { affiliate_id: string; unique_permalink?: string }): Promise<Response> {
  // A format suffix ("/a/1.json") is Rails' route format, and Next.js's segment keeps it.
  if (Object.values(params).some((segment) => segment.includes("."))) return handBack(incoming);
  return processAction(incoming, {}, async ({ request }): Promise<ActionResult> => {
    const affiliate = await affiliateOf(params.affiliate_id);
    const cookie = await affiliateCookie(request, affiliate, new Date());

    const product = params.unique_permalink === undefined ? null : await productByPermalink(params.unique_permalink);
    const destination = await finalDestinationUrl(affiliate, product);
    const location = mergeQueries(destination, request, params.affiliate_id, present(affiliate.destination_url));
    return { status: FOUND, location, ...(cookie === null ? {} : { cookies: [cookie] }) };
  });
}

// Rails keeps the route's optional format segment, which this port does not model.
function handBack(incoming: Request): Promise<Response> {
  return processAction(incoming, {}, () => {
    throw new HandBackToRails("a format suffix on an affiliate link");
  });
}

// `Link.find_by(unique_permalink: params[:unique_permalink]) if params[:unique_permalink].present?`
async function productByPermalink(permalink: string): Promise<LinkRow | null> {
  if (!present(permalink)) return null;
  const [row] = await selectRows<LinkRow>(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`);
  return row ?? null;
}
