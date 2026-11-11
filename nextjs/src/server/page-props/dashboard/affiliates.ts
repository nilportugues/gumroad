// AffiliatesPresenter (index, onboarding, new and edit props) and DirectAffiliate#as_json /
// #products_data, over plain SQL.
import { Prisma, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt as externalId, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { rubyStrip, subdomain, UserFlags, Users } from "../../models/user.ts";
import { roleAdminFor, roleMarketingFor, requireUser, type SellerContext } from "../../policies/seller-context.ts";
import { domainConfig } from "../domain.ts";
import { tzinfoName } from "../signed-in/data.ts";
import { displayName } from "../signed-in/presenters.ts";

import { hasBrazilianStripeConnectAccount } from "./payout-info.ts";

export const AFFILIATES_PER_PAGE = 100;
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const ARCHIVED_FLAG = 2 ** 4;
const IS_COLLAB_FLAG = 2 ** 27;
const PERCENT_BASIS = 100;

export const SORT_KEYS = ["affiliate_user_name", "products", "fee_percent", "volume_cents"] as const;
export type Sort = { key: (typeof SORT_KEYS)[number]; direction: "asc" | "desc" };

type AffiliateRow = {
  id: number;
  seller_id: number;
  affiliate_user_id: number;
  affiliate_basis_points: number | null;
  flags: number;
  destination_url: string | null;
};
type AssignmentRow = {
  affiliate_id: number;
  link_id: number;
  affiliate_basis_points: number | null;
  destination_url: string | null;
  product_name: string | null;
  unique_permalink: string | null;
  product_alive: number | boolean | null;
};
type ProductRow = { id: bigint; name: string; flags: bigint; unique_permalink: string | null };

// Affiliate#affiliate_percentage
const percentage = (basisPoints: number | null) =>
  basisPoints === null ? null : Math.floor(basisPoints / PERCENT_BASIS);

// Ruby compares strings bytewise.
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function affiliatesDisabledReason(seller: User) {
  return (await hasBrazilianStripeConnectAccount(seller.id))
    ? "Affiliates with Brazilian Stripe accounts are not supported."
    : null;
}

// `seller.links.alive.affiliate_eligible_for(seller)`, in id order.
async function eligibleProducts(seller: User): Promise<ProductRow[]> {
  const l = (name: string) => column("links", name);
  const collabAndAffiliates = await isFeatureEnabled("collab_and_affiliates", userActor(seller.id));
  const notCollab = collabAndAffiliates ? Prisma.empty : Prisma.sql`AND (${l("flags")} & ${IS_COLLAB_FLAG} = 0)`;
  return selectRows<ProductRow>(
    Prisma.sql`SELECT ${l("id")}, ${l("name")}, ${l("flags")}, ${l("unique_permalink")} FROM ${table("links")} WHERE ${l("user_id")} = ${seller.id} AND ${l("purchase_disabled_at")} IS NULL AND ${l("banned_at")} IS NULL AND ${l("deleted_at")} IS NULL ${notCollab} ORDER BY ${l("id")} ASC`,
  );
}

const isArchived = (product: ProductRow) => (BigInt(product.flags) & BigInt(ARCHIVED_FLAG)) !== 0n;

type SelfServiceDetails = {
  enabled: boolean;
  id: number;
  name: string;
  fee_percent: number | null;
  destination_url: string | null;
};

// AffiliatesPresenter#self_service_affiliate_product_details, keyed by product id in insertion order.
export async function selfServiceAffiliateProductDetails(seller: User): Promise<Map<number, SelfServiceDetails>> {
  const s = (name: string) => column("self_service_affiliate_products", name);
  const existing = await selectRows<{
    product_id: bigint;
    enabled: number | boolean;
    affiliate_basis_points: number;
    destination_url: string | null;
    name: string;
  }>(
    Prisma.sql`SELECT ${s("product_id")}, ${s("enabled")}, ${s("affiliate_basis_points")}, ${s("destination_url")}, ${column("links", "name")} AS name FROM ${table("self_service_affiliate_products")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${s("product_id")} WHERE ${s("seller_id")} = ${seller.id} ORDER BY ${s("id")} ASC`,
  );
  const details = new Map<number, SelfServiceDetails>();
  for (const row of existing) {
    const fee = Math.floor(row.affiliate_basis_points / PERCENT_BASIS);
    details.set(Number(row.product_id), {
      enabled: Number(row.enabled) === 1,
      id: encryptNumeric(Number(row.product_id)),
      name: row.name,
      fee_percent: fee === 0 ? null : fee,
      destination_url: row.destination_url,
    });
  }
  for (const product of await eligibleProducts(seller)) {
    const current = details.get(Number(product.id)) ?? {
      enabled: false,
      id: encryptNumeric(Number(product.id)),
      name: product.name,
      fee_percent: null,
      destination_url: null,
    };
    if (isArchived(product) && !current.enabled) continue;
    details.set(Number(product.id), current);
  }
  return details;
}

async function productsProps(seller: User): Promise<SelfServiceDetails[]> {
  return [...(await selfServiceAffiliateProductDetails(seller)).values()].sort(
    (a, b) => Number(!a.enabled) - Number(!b.enabled) || byteCompare(a.name, b.name),
  );
}

const exists = async (sql: Prisma.Sql) => (await selectRows(sql)).length > 0;

export const hasEnabledSelfServiceAffiliateProducts = (sellerId: bigint) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("self_service_affiliate_products")} WHERE ${column("self_service_affiliate_products", "seller_id")} = ${sellerId} AND ${column("self_service_affiliate_products", "enabled")} = TRUE LIMIT 1`,
  );

export async function onboardingProps(seller: User) {
  const products = await productsProps(seller);
  const l = (name: string) => column("links", name);
  const [global] = await selectRows<{ affiliate_basis_points: number | null }>(
    Prisma.sql`SELECT ${column("affiliates", "affiliate_basis_points")} FROM ${table("affiliates")} WHERE ${column("affiliates", "affiliate_user_id")} = ${seller.id} AND ${column("affiliates", "type")} = 'GlobalAffiliate' ORDER BY ${column("affiliates", "id")} ASC LIMIT 1`,
  );
  return {
    creator_subdomain: subdomain(Users.load(seller)),
    products,
    disable_global_affiliate: UserFlags.isSet(seller.flags, "disable_global_affiliate"),
    global_affiliate_percentage: global ? percentage(global.affiliate_basis_points) : null,
    affiliates_disabled_reason: await affiliatesDisabledReason(seller),
    collab_products_only:
      products.length === 0 &&
      (await exists(
        Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${l("user_id")} = ${seller.id} AND ${l("purchase_disabled_at")} IS NULL AND ${l("banned_at")} IS NULL AND ${l("deleted_at")} IS NULL AND (${l("flags")} & ${IS_COLLAB_FLAG} > 0) LIMIT 1`,
      )),
  };
}

export async function newAffiliateProps(seller: User) {
  const products = (await productsProps(seller)).map((product) => ({
    ...product,
    enabled: false,
    fee_percent: null,
    referral_url: "",
    destination_url: null,
  }));
  return { products, affiliates_disabled_reason: await affiliatesDisabledReason(seller) };
}

// ---- index ----

function listSql(seller: User, query: string | null, sort: Sort | null) {
  const a = (name: string) => column("affiliates", name);
  const volumeJoin =
    sort?.key === "volume_cents"
      ? Prisma.sql`LEFT OUTER JOIN ${table("purchases")} ON purchases.purchase_state = 'successful' AND purchases.affiliate_id = affiliates.id AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0))`
      : Prisma.empty;
  const userJoin =
    sort?.key === "affiliate_user_name" || query !== null
      ? Prisma.sql`INNER JOIN ${table("users")} ON users.id = affiliates.affiliate_user_id`
      : Prisma.empty;
  const like =
    query === null
      ? Prisma.empty
      : Prisma.sql`AND (users.username LIKE ${`%${rubyStrip(query)}%`} OR users.email LIKE ${`%${rubyStrip(query)}%`} OR users.name LIKE ${`%${rubyStrip(query)}%`})`;
  const from = Prisma.sql`FROM ${table("affiliates")} ${userJoin} ${volumeJoin} LEFT OUTER JOIN ${table("affiliates_links")} ON affiliates_links.affiliate_id = affiliates.id WHERE ${a("type")} = 'DirectAffiliate' AND ${a("seller_id")} = ${seller.id} AND ${a("deleted_at")} IS NULL ${like} GROUP BY ${a("id")}`;

  const direction = sort?.direction === "desc" ? Prisma.raw("desc") : Prisma.raw("asc");
  let order = Prisma.empty;
  switch (sort?.key) {
    case "affiliate_user_name":
      order = Prisma.sql`CASE WHEN users.name IS NOT NULL THEN users.name WHEN users.username != users.external_id THEN users.username WHEN users.unconfirmed_email IS NOT NULL THEN users.unconfirmed_email ELSE users.email END ${direction}, `;
      break;
    case "products":
      order = Prisma.sql`COUNT(affiliates_links.id) ${direction}, `;
      break;
    case "fee_percent":
      order = Prisma.sql`MIN(affiliates_links.affiliate_basis_points) ${direction}, `;
      break;
    case "volume_cents":
      order = Prisma.sql`SUM(purchases.price_cents) ${direction}, `;
      break;
  }
  return { from, order: Prisma.sql`ORDER BY ${order}MAX(affiliates_links.updated_at) DESC` };
}

async function affiliatesPage(seller: User, query: string | null, sort: Sort | null, requestedPage: number) {
  const { from, order } = listSql(seller, query, sort);
  const [counted] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM (SELECT ${column("affiliates", "id")} ${from}) AS grouped`,
  );
  const total = Number(counted!.count);
  const last = Math.max(Math.ceil(total / AFFILIATES_PER_PAGE), 1);
  const page = Math.min(requestedPage, last);
  const ids = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${column("affiliates", "id")} ${from} ${order} LIMIT ${AFFILIATES_PER_PAGE} OFFSET ${(page - 1) * AFFILIATES_PER_PAGE}`,
  );
  const rows =
    ids.length === 0
      ? []
      : await selectRows<AffiliateRow>(
          Prisma.sql`SELECT ${column("affiliates", "id")}, ${column("affiliates", "seller_id")}, ${column("affiliates", "affiliate_user_id")}, ${column("affiliates", "affiliate_basis_points")}, ${column("affiliates", "flags")}, ${column("affiliates", "destination_url")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} IN (${Prisma.join(ids.map((row) => row.id))})`,
        );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { rows: ids.map((row) => byId.get(row.id)!), page, last, overflow: requestedPage > last };
}

async function assignmentsFor(affiliateIds: number[]): Promise<AssignmentRow[]> {
  if (affiliateIds.length === 0) return [];
  const pa = (name: string) => column("affiliates_links", name);
  return selectRows<AssignmentRow>(
    Prisma.sql`SELECT ${pa("affiliate_id")} AS affiliate_id, ${pa("link_id")} AS link_id, ${pa("affiliate_basis_points")} AS affiliate_basis_points, ${pa("destination_url")} AS destination_url, ${column("links", "name")} AS product_name, ${column("links", "unique_permalink")} AS unique_permalink, (${column("links", "id")} IS NOT NULL AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL) AS product_alive FROM ${table("affiliates_links")} LEFT OUTER JOIN ${table("links")} ON ${column("links", "id")} = ${pa("link_id")} WHERE ${pa("affiliate_id")} IN (${Prisma.join(affiliateIds)}) ORDER BY ${pa("id")} ASC`,
  );
}

async function aliveLinkCount(sellerId: bigint): Promise<number> {
  const l = (name: string) => column("links", name);
  const [row] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("links")} WHERE ${l("user_id")} = ${sellerId} AND ${l("purchase_disabled_at")} IS NULL AND ${l("banned_at")} IS NULL AND ${l("deleted_at")} IS NULL`,
  );
  return Number(row!.count);
}

const referralUrl = (affiliateId: number) => {
  const config = domainConfig(process.env);
  return `${config.protocol}://${config.rootDomain}/a/${encryptNumeric(affiliateId)}`;
};

// Affiliate#affiliate_info
function affiliateInfo(affiliate: AffiliateRow, user: User) {
  return {
    id: externalId(affiliate.id),
    email: user.email,
    destination_url: affiliate.destination_url,
    affiliate_user_name: displayName(user, { preferEmailOverDefaultUsername: true }),
    fee_percent: percentage(affiliate.affiliate_basis_points),
  };
}

// DirectAffiliate#as_json
function affiliateJson(affiliate: AffiliateRow, user: User, assignments: AssignmentRow[], aliveLinks: number) {
  const own = percentage(affiliate.affiliate_basis_points);
  const products = assignments
    .filter((assignment) => Number(assignment.product_alive) === 1)
    .map((assignment) => ({
      id: encryptNumeric(assignment.link_id),
      name: assignment.product_name,
      fee_percent: percentage(assignment.affiliate_basis_points) ?? own,
      destination_url: assignment.destination_url,
      referral_url: `${referralUrl(affiliate.id)}/${assignment.unique_permalink}`,
    }));
  return {
    ...affiliateInfo(affiliate, user),
    products,
    apply_to_all_products: products.every((product) => product.fee_percent === own) && products.length === aliveLinks,
    product_referral_url:
      assignments.length === 1
        ? `${referralUrl(affiliate.id)}/${assignments[0]!.unique_permalink}`
        : referralUrl(affiliate.id),
  };
}

const ISO_PARTS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
} as const;

// created_at.in_time_zone(zone).iso8601
export function iso8601InZone(date: Date, railsZone: string): string {
  const zone = tzinfoName(railsZone);
  if (zone === null) throw new TypeError(`unknown time zone ${JSON.stringify(railsZone)}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { ...ISO_PARTS, timeZone: zone })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const text = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  if (offsetMinutes === 0) return `${text}Z`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${text}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// AffiliateRequestPolicy#update?
export function affiliateRequestUpdatable(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

async function affiliateRequests(seller: User, context: SellerContext) {
  const r = (name: string) => column("affiliate_requests", name);
  const rows = await selectRows<{
    id: bigint;
    name: string;
    email: string;
    promotion_text: string;
    state: string | null;
    created_at: Date;
  }>(
    Prisma.sql`SELECT ${r("id")}, ${r("name")}, ${r("email")}, ${r("promotion_text")}, ${r("state")}, ${r("created_at")} FROM ${table("affiliate_requests")} LEFT OUTER JOIN users ON users.email = affiliate_requests.email WHERE ${r("seller_id")} = ${seller.id} AND (users.id IS NULL AND ${r("state")} IN ('approved') OR ${r("state")} IN ('created')) ORDER BY ${r("created_at")} DESC, ${r("id")} DESC`,
  );
  return rows.map((row) => ({
    id: externalId(row.id),
    name: row.name,
    email: row.email,
    promotion: row.promotion_text,
    date: iso8601InZone(row.created_at, seller.timezone),
    state: row.state,
    can_update: affiliateRequestUpdatable(context),
  }));
}

export type IndexInput = { page: number; query: string | null; sort: Sort | null; shouldGetAffiliateRequests: boolean };

export async function affiliatesIndexProps(
  seller: User,
  context: SellerContext,
  { page, query, sort, shouldGetAffiliateRequests }: IndexInput,
) {
  const result = await affiliatesPage(seller, query, sort, page);
  const users = new Map(
    (await db.user.findMany({ where: { id: { in: result.rows.map((row) => BigInt(row.affiliate_user_id)) } } })).map(
      (user) => [Number(user.id), user],
    ),
  );
  const assignments = await assignmentsFor(result.rows.map((row) => row.id));
  const aliveLinks = await aliveLinkCount(seller.id);
  const affiliates = result.rows.map((row) =>
    affiliateJson(
      row,
      users.get(row.affiliate_user_id)!,
      assignments.filter((assignment) => assignment.affiliate_id === row.id),
      aliveLinks,
    ),
  );
  const requests =
    shouldGetAffiliateRequests || (result.overflow && result.page === 1)
      ? await affiliateRequests(seller, context)
      : [];
  return {
    affiliate_requests: requests,
    affiliates,
    pagination: { pages: result.last, page: result.page },
    allow_approve_all_requests: await isFeatureEnabled("auto_approve_affiliates", userActor(seller.id)),
    affiliates_disabled_reason: await affiliatesDisabledReason(seller),
  };
}

// ---- edit ----

// `current_seller.direct_affiliates.find_by_external_id(id)` (deleted rows included).
export async function findDirectAffiliate(sellerId: bigint, id: number): Promise<AffiliateRow | null> {
  const a = (name: string) => column("affiliates", name);
  const [row] = await selectRows<AffiliateRow>(
    Prisma.sql`SELECT ${a("id")}, ${a("seller_id")}, ${a("affiliate_user_id")}, ${a("affiliate_basis_points")}, ${a("flags")}, ${a("destination_url")} FROM ${table("affiliates")} WHERE ${a("type")} = 'DirectAffiliate' AND ${a("seller_id")} = ${sellerId} AND ${a("id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

export async function editAffiliateProps(seller: User, affiliate: AffiliateRow) {
  const user = (await db.user.findUnique({ where: { id: BigInt(affiliate.affiliate_user_id) } }))!;
  const assignments = await assignmentsFor([affiliate.id]);
  const credits = await selectRows<{ link_id: number; volume_cents: bigint; sales_count: bigint }>(
    Prisma.sql`SELECT ${column("affiliate_credits", "link_id")} AS link_id, CAST(SUM(purchases.price_cents) AS SIGNED) AS volume_cents, COUNT(purchases.id) AS sales_count FROM ${table("affiliate_credits")} INNER JOIN ${table("purchases")} ON purchases.id = affiliate_credits.purchase_id WHERE ${column("affiliate_credits", "affiliate_id")} = ${affiliate.id} ${assignments.length === 0 ? Prisma.sql`AND 1 = 0` : Prisma.sql`AND ${column("affiliate_credits", "link_id")} IN (${Prisma.join(assignments.map((assignment) => assignment.link_id))})`} AND purchases.purchase_state = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) GROUP BY ${column("affiliate_credits", "link_id")}`,
  );
  const own = percentage(affiliate.affiliate_basis_points);
  const products = [];
  for (const product of await eligibleProducts(seller)) {
    const assignment = assignments.find((candidate) => candidate.link_id === Number(product.id));
    if (isArchived(product) && !assignment) continue;
    const credit = credits.find((candidate) => candidate.link_id === Number(product.id));
    products.push({
      id: encryptNumeric(Number(product.id)),
      enabled: assignment !== undefined,
      name: product.name,
      volume_cents: credit ? Number(credit.volume_cents) : 0,
      sales_count: credit ? Number(credit.sales_count) : 0,
      fee_percent: (assignment ? percentage(assignment.affiliate_basis_points) : null) ?? own,
      referral_url: `${referralUrl(affiliate.id)}/${product.unique_permalink}`,
      destination_url: assignment?.destination_url ?? null,
    });
  }
  products.sort((a, b) => Number(!a.enabled) - Number(!b.enabled) || b.volume_cents - a.volume_cents);
  return {
    affiliate: { ...affiliateInfo(affiliate, user), products },
    affiliates_disabled_reason: await affiliatesDisabledReason(seller),
  };
}

export const affiliateAppliesToAllProducts = (affiliate: AffiliateRow) =>
  (affiliate.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0;
