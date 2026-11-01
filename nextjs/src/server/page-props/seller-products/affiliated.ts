// AffiliatedProductsPresenter#affiliated_products_page_props for Products::AffiliatedController#index.
// The lifetime earnings of the user's GlobalAffiliate are summed here, bounded by AffiliateEarningsCache's
// in-request limit; an affiliate whose sum does not finish in time goes to Rails whole, which caches it and
// hands the work to a background job. Rails serves a cached sum for up to AffiliateEarningsCache::STALE_AFTER
// before recomputing, which the port does not model (it always reads the current sum).
import { Prisma, type User } from "@prisma/client";

import { encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { selectRows, table } from "../../models/sql.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { piracyReportsTabVisible, productsAffiliatedDirectAffiliatePolicy } from "../../policies/link.ts";
import { formatMoney } from "../audience/filters.ts";
import { paramToI } from "../audience/support.ts";
import { domainConfig } from "../domain.ts";
import { hasBrazilianStripeConnectAccount } from "../dashboard/payout-info.ts";
import { externalId } from "../audience/support.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { archivedProductsCount } from "./dashboard-products.ts";

export const AFFILIATED_PER_PAGE = 20;
// GlobalAffiliate::AFFILIATE_COOKIE_LIFETIME_DAYS, Affiliate::SHORT_QUERY_PARAM
const GLOBAL_AFFILIATE_COOKIE_LIFETIME_DAYS = 7;
const SHORT_QUERY_PARAM = "a";

export type AffiliatedParams = { query: string | null; page: string | null; sort: { key: string | null; direction: string | null } | null };

// Rack parses `sort[key]` and `sort[direction]` into a hash; any other bracketed parameter is left to Rails.
export function affiliatedParams(queryString: string): AffiliatedParams {
  let query: string | null = null;
  let page: string | null = null;
  let key: string | null = null;
  let direction: string | null = null;
  let sorted = false;
  for (const pair of queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const name = decode(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? "" : decode(pair.slice(index + 1));
    if (name === "query") query = value;
    else if (name === "page") page = value;
    else if (name === "sort[key]") {
      key = value;
      sorted = true;
    } else if (name === "sort[direction]") {
      direction = value;
      sorted = true;
    } else if (name.includes("[") || name === "sort") throw new HandBackToRails();
  }
  return { query, page, sort: sorted ? { key, direction } : null };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

type GroupedRow = {
  link_id: bigint;
  affiliate_id: bigint;
  unique_permalink: string;
  name: string;
  affiliate_type: string;
  basis_points: number | null;
  revenue: bigint | number | string | null;
  sales_count: bigint;
};

// The user's live direct and global affiliations.
const affiliationIds = (userId: bigint) =>
  Prisma.sql`SELECT id FROM affiliates WHERE type IN ('DirectAffiliate', 'GlobalAffiliate') AND deleted_at IS NULL AND affiliate_user_id = ${userId}`;

function scopeSql(userId: bigint, query: string | null): { from: Prisma.Sql; where: Prisma.Sql } {
  const filter = query !== null && query.trim() !== "" ? Prisma.sql` AND links.name LIKE ${`%${query.trim()}%`}` : Prisma.empty;
  return {
    from: Prisma.sql`affiliates_links INNER JOIN links ON links.id = affiliates_links.link_id INNER JOIN affiliates ON affiliates.id = affiliates_links.affiliate_id`,
    where: Prisma.sql`affiliates_links.affiliate_id IN (${affiliationIds(userId)}) AND links.deleted_at IS NULL AND links.banned_at IS NULL${filter}`,
  };
}

const count = async (sql: Prisma.Sql) => Number((await selectRows<{ count: bigint }>(sql))[0]?.count ?? 0);

// AffiliateEarningsCache::REQUEST_TIMEOUT_MS
const REQUEST_TIMEOUT_MS = 3_000;
// Purchase flag 10, :chargeback_reversed
const CHARGEBACK_REVERSED_FLAG = 512;

async function globalAffiliateId(userId: bigint): Promise<bigint | null> {
  const [row] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT id FROM ${table("affiliates")} WHERE type = 'GlobalAffiliate' AND deleted_at IS NULL AND affiliate_user_id = ${userId} ORDER BY id ASC LIMIT 1`);
  return row ? BigInt(row.id) : null;
}

// Affiliate#total_cents_earned(timeout_ms:): `purchases.paid.not_chargedback_or_chargedback_reversed`
async function totalCentsEarned(affiliateId: bigint): Promise<number> {
  try {
    const [row] = await selectRows<{ total: bigint | string | null }>(
      Prisma.sql`SELECT /*+ MAX_EXECUTION_TIME(${Prisma.raw(String(REQUEST_TIMEOUT_MS))}) */ COALESCE(SUM(purchases.affiliate_credit_cents), 0) AS total FROM purchases
        WHERE purchases.affiliate_id = ${affiliateId} AND purchases.purchase_state = 'successful' AND purchases.price_cents > 0 AND (stripe_refunded IS NULL OR stripe_refunded = 0)
        AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & ${CHARGEBACK_REVERSED_FLAG} != 0))`,
    );
    return Number(row?.total ?? 0);
  } catch {
    throw new HandBackToRails();
  }
}

// User#should_be_shown_currencies_always?
async function showCurrencyAlways(user: User): Promise<boolean> {
  if ((user.currency_type ?? "usd") !== "usd") return true;
  const [payment] = await selectRows<{ currency: string | null }>(Prisma.sql`SELECT currency FROM ${table("payments")} WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 1`);
  return payment !== undefined && payment.currency !== null && payment.currency !== "usd";
}

export async function assertAffiliatedSupported(user: User, queryString: string): Promise<void> {
  affiliatedParams(queryString);
  const id = await globalAffiliateId(user.id);
  if (id !== null) await totalCentsEarned(id);
}

// Active Support's BigDecimal#as_json is its string form; an Integer stays a number.
export async function affiliatedProductsProps(user: User, context: SellerContext, params: AffiliatedParams, canRemoveAffiliations: boolean) {
  const query = params.query !== null && params.query.trim() !== "" ? params.query : null;
  const { from, where } = scopeSql(user.id, query);
  const total = await count(
    Prisma.sql`SELECT COUNT(DISTINCT affiliates_links.link_id, affiliates_links.affiliate_id, COALESCE(affiliates_links.affiliate_basis_points || affiliates.affiliate_basis_points, -1)) AS count FROM ${from} WHERE ${where}`,
  );
  const last = Math.max(Math.ceil(total / AFFILIATED_PER_PAGE), 1);
  const page = Math.min(Math.max(paramToI(params.page ?? "0"), 1), last);

  const direction = params.sort?.direction?.toUpperCase() === "DESC" ? "DESC" : "ASC";
  const orderBy = (() => {
    switch (params.sort?.key) {
      case "product_name": return `links.name ${direction}`;
      case "revenue": return `revenue ${direction}`;
      case "sales_count": return `sales_count ${direction}`;
      case "commission": return `basis_points ${direction}`;
      default: return "affiliates.created_at ASC";
    }
  })();
  const rows = await selectRows<GroupedRow>(
    Prisma.sql`SELECT affiliates_links.link_id AS link_id, affiliates_links.affiliate_id AS affiliate_id, links.unique_permalink AS unique_permalink, links.name AS name, affiliates.type AS affiliate_type,
      COALESCE(affiliates_links.affiliate_basis_points, affiliates.affiliate_basis_points) AS basis_points,
      SUM(affiliate_credits.amount_cents) AS revenue, COUNT(DISTINCT affiliate_credits.id) AS sales_count
      FROM ${from} LEFT OUTER JOIN affiliate_credits ON affiliates_links.link_id = affiliate_credits.link_id AND affiliate_credits.affiliate_id = affiliates_links.affiliate_id AND affiliate_credits.affiliate_credit_chargeback_balance_id IS NULL AND affiliate_credits.affiliate_credit_refund_balance_id IS NULL
      WHERE ${where}
      GROUP BY affiliates_links.link_id, affiliates_links.affiliate_id, links.unique_permalink, links.name, affiliates.type, affiliates_links.affiliate_basis_points || affiliates.affiliate_basis_points
      ORDER BY ${Prisma.raw(orderBy)}, affiliates_links.id ASC LIMIT ${AFFILIATED_PER_PAGE} OFFSET ${(page - 1) * AFFILIATED_PER_PAGE}`,
  );

  const removable = new Map<bigint, { sellerName: string | null }>();
  const directIds = rows.filter((row) => row.affiliate_type === "DirectAffiliate").map((row) => BigInt(row.affiliate_id));
  if (canRemoveAffiliations && directIds.length > 0) {
    const sellers = await selectRows<{ id: bigint; name: string | null; username: string | null; external_id: string | null }>(
      Prisma.sql`SELECT affiliates.id AS id, users.name AS name, users.username AS username, users.external_id AS external_id FROM affiliates LEFT JOIN users ON users.id = affiliates.seller_id WHERE affiliates.id IN (${Prisma.join(directIds)})`,
    );
    for (const row of sellers) removable.set(BigInt(row.id), { sellerName: row.name && row.name !== "" ? row.name : row.username });
  }

  const protocol = domainConfig(process.env).protocol;
  const rootDomain = domainConfig(process.env).rootDomain;
  const products = rows.map((row) => {
    const revenue = row.revenue === null ? 0 : typeof row.revenue === "bigint" ? Number(row.revenue) : Number(row.revenue);
    const direct = removable.get(BigInt(row.affiliate_id));
    return {
      product_name: row.name,
      url: `${protocol}://${rootDomain}/a/${encryptNumeric(Number(row.affiliate_id))}/${row.unique_permalink}`,
      fee_percentage: Math.floor((row.basis_points ?? 0) / 100),
      revenue,
      humanized_revenue: `$${formatMoney(revenue, "usd")}`,
      sales_count: Number(row.sales_count),
      affiliate_type: row.affiliate_type === "DirectAffiliate" ? "direct_affiliate" : "global_affiliate",
      affiliate_id: direct ? externalId(BigInt(row.affiliate_id)) : null,
      seller_name: direct?.sellerName ?? null,
    };
  });

  const globalId = await globalAffiliateId(user.id);
  // Unfiltered on purpose: the account's headline totals.
  const unfiltered = scopeSql(user.id, null);
  const [credits] = await selectRows<{ total: bigint | string | null; count: bigint }>(Prisma.sql`SELECT SUM(amount_cents) AS total, COUNT(*) AS count FROM affiliate_credits WHERE affiliate_user_id = ${user.id}`);
  const stats = {
    total_revenue: credits?.total == null ? 0 : Number(credits.total),
    total_sales: Number(credits?.count ?? 0),
    total_products: await count(Prisma.sql`SELECT COUNT(DISTINCT affiliates_links.link_id) AS count FROM ${unfiltered.from} WHERE ${unfiltered.where}`),
    total_affiliated_creators: await count(Prisma.sql`SELECT COUNT(DISTINCT links.user_id) AS count FROM ${unfiltered.from} WHERE ${unfiltered.where}`),
  };

  return {
    pagination: { pages: last, page },
    affiliated_products: products,
    stats,
    global_affiliates_data: {
      global_affiliate_id: globalId === null ? null : encryptNumeric(Number(globalId)),
      global_affiliate_sales: globalId === null ? null : formattedDollarAmount(await totalCentsEarned(globalId), { withCurrency: await showCurrencyAlways(user) }),
      cookie_expiry_days: GLOBAL_AFFILIATE_COOKIE_LIFETIME_DAYS,
      affiliate_query_param: SHORT_QUERY_PARAM,
    },
    discover_url: `${protocol}://${domainConfig(process.env).discoverDomain}`,
    archived_tab_visible: (await archivedProductsCount(user)) > 0,
    affiliates_disabled_reason: (await hasBrazilianStripeConnectAccount(user.id)) ? "Affiliates with Brazilian Stripe accounts are not supported." : null,
    piracy_reports_tab_visible: await piracyReportsTabVisible(context),
  };
}

export const canRemoveAffiliations = (context: SellerContext) => productsAffiliatedDirectAffiliatePolicy.destroy(context);
