// CollabProductsPagePresenter: the props of Products/Collabs/Index. The tables and stats sum each product's sales in
// Elasticsearch (Product::Stats#total_usd_cents_earned_by_user, #active_customers_count).
import { Prisma, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { collaboratingProductIds, linkPolicy, piracyReportsTabVisible } from "../../policies/link.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { type Aggregations, affiliateCreditAggs, aggregationValue, ownAffiliateCreditCents } from "../../search/purchase-sales.ts";
import { hasBrazilianStripeConnectAccount } from "../dashboard/payout-info.ts";
import {
  assertPriceSupported,
  assertStatsCached,
  assertTableSupported,
  assertThumbnailsSupported,
  displayPriceCents,
  externalEditPath,
  freshCachedStats,
  hasDuration,
  type LinkRow,
  type ListingParams,
  loadRowData,
  priceFormattedVerbose,
  productFlag,
  productUrls,
  sortAndPaginate,
  thumbnailJson,
} from "./listing.ts";
import { archivedProductsCount } from "./dashboard-products.ts";

export const COLLAB_SORT_KEYS = ["name", "display_price_cents", "cut", "successful_sales_count", "revenue"] as const;
type Kind = "products" | "memberships";

const present = (value: string | null): value is string => value !== null && value.trim() !== "";

// Link.collabs_as_seller_or_collaborator(user): the product's collaborations the user is the seller or the collaborator of
// (an accepted, alive Collaborator), joined once per collaboration as ActiveRecord joins them.
function collabsQuery(userId: bigint, params: ListingParams, kind: Kind | null) {
  const flag = kind === null ? Prisma.empty : Prisma.sql` AND ${LinkFlags.condition("is_recurring_billing", kind === "memberships")}`;
  const search = present(params.query) ? Prisma.sql` AND links.name LIKE ${`%${params.query}%`}` : Prisma.empty;
  return {
    from: Prisma.sql`${table("links")} INNER JOIN affiliates_links ON affiliates_links.link_id = links.id INNER JOIN affiliates ON affiliates.id = affiliates_links.affiliate_id`,
    where: Prisma.sql`${LinkFlags.condition("is_collab", true)} AND (affiliates.seller_id = ${userId} OR affiliates.affiliate_user_id = ${userId}) AND affiliates.type = 'Collaborator'
      AND NOT EXISTS (SELECT 1 FROM collaborator_invitations WHERE collaborator_invitations.collaborator_id = affiliates.id) AND affiliates.deleted_at IS NULL${flag}${search}`,
  };
}

const CHARGED_STATES = ["preorder_authorization_successful", "successful", "preorder_concluded_successfully"];
const CHARGED_SALES_OPTIONS = {
  state: CHARGED_STATES,
  exclude_giftees: true,
  exclude_refunded: true,
  exclude_unreversed_chargedback: true,
  exclude_non_successful_preorder_authorizations: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};
const ALL_SUCCESS_STATES_EXCEPT_PREORDER_AUTH = ["successful", "not_charged", "gift_receiver_purchase_successful"];

const aggregationsOf = (result: { response: { aggregations?: unknown } }) => result.response.aggregations as Aggregations;

// The PurchaseSearchService options of Product::Stats#total_usd_cents_earned_by_user
export function earnedByUserOptions(productId: bigint, productUserId: bigint | null, userId: bigint) {
  const forSeller = productUserId !== null && userId === productUserId;
  const aggs = forSeller
    ? {
        price_cents_total: { sum: { field: "price_cents" } },
        amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
        affiliate_cents_total: { sum: { field: "affiliate_credit_amount_cents" } },
        affiliate_fees_total: { sum: { field: "affiliate_credit_fee_cents" } },
        direct_affiliate_cents_total: { sum: { field: "direct_affiliate_credit_amount_cents" } },
        direct_affiliate_fees_total: { sum: { field: "direct_affiliate_credit_fee_cents" } },
      }
    : affiliateCreditAggs(Number(userId));
  return { forSeller, options: { ...CHARGED_SALES_OPTIONS, product: Number(productId), size: 0, aggs, [forSeller ? "seller" : "affiliate_user"]: Number(userId) } };
}

// Product::Stats#total_usd_cents_earned_by_user
export async function totalUsdCentsEarnedByUser(productId: bigint, productUserId: bigint | null, userId: bigint): Promise<number> {
  const { forSeller, options } = earnedByUserOptions(productId, productUserId, userId);
  const result = await PurchaseSearchService.process(options);
  const aggregations = aggregationsOf(result);
  const value = (name: string) => aggregationValue(aggregations[name]?.value, name);
  if (forSeller) {
    const affiliateTotal = value("affiliate_cents_total") + value("affiliate_fees_total") - value("amount_refunded_cents_total");
    const directAffiliateTotal = value("direct_affiliate_cents_total") + value("direct_affiliate_fees_total");
    return value("price_cents_total") - affiliateTotal - directAffiliateTotal;
  }
  const earned = ownAffiliateCreditCents(aggregations, "amount_cents") + ownAffiliateCreditCents(aggregations, "fee_cents");
  return earned - ownAffiliateCreditCents(aggregations, "amount_partially_refunded_cents");
}

// The PurchaseSearchService options of Product::Stats#active_customers_count
export const activeCustomersOptions = (productId: bigint) => ({
    product: Number(productId),
    state: ALL_SUCCESS_STATES_EXCEPT_PREORDER_AUTH,
    exclude_giftees: true,
    exclude_refunded_except_subscriptions: true,
    exclude_deactivated_subscriptions: true,
    exclude_unreversed_chargedback: true,
    exclude_non_original_subscription_purchases: true,
    exclude_commission_completion_purchases: true,
    exclude_bundle_product_purchases: true,
    size: 0,
    aggs: { unique_email_count: { cardinality: { field: "email.raw" } } },
});

export async function activeCustomersCount(productId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process(activeCustomersOptions(productId));
  return aggregationValue(aggregationsOf(result).unique_email_count?.value, "unique_email_count");
}

// Link#percentage_revenue_cut_for_user, for a collab: the seller keeps what the confirmed collaborator does not.
async function revenueCut(row: LinkRow, userId: bigint): Promise<number> {
  const isSeller = row.user_id !== null && BigInt(row.user_id) === userId;
  const [collaborator] = await selectRows<{ id: bigint; affiliate_user_id: bigint; basis_points: number | null }>(
    Prisma.sql`SELECT affiliates.id AS id, affiliates.affiliate_user_id AS affiliate_user_id, affiliates_links.affiliate_basis_points AS basis_points FROM affiliates
      INNER JOIN affiliates_links ON affiliates_links.affiliate_id = affiliates.id
      WHERE affiliates_links.link_id = ${row.id} AND affiliates.type = 'Collaborator' AND affiliates.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM collaborator_invitations WHERE collaborator_invitations.collaborator_id = affiliates.id) ORDER BY affiliates.id ASC LIMIT 1`,
  );
  if (!collaborator) return isSeller ? 100 : 0;
  // `affiliate_percentage` is nil without basis points, which Rails then subtracts from 100.
  if (collaborator.basis_points === null) throw new HandBackToRails();
  const percentage = Math.floor(collaborator.basis_points / 100);
  if (isSeller) return 100 - percentage;
  return BigInt(collaborator.affiliate_user_id) === userId ? percentage : 0;
}

async function tableRows(seller: User, params: ListingParams, kind: Kind) {
  const { from, where } = collabsQuery(seller.id, params, kind);
  return sortAndPaginate({ from, where, table: params[kind], sellerId: seller.id });
}

export async function assertCollabsSupported(seller: User, params: ListingParams): Promise<void> {
  assertTableSupported(params.products);
  assertTableSupported(params.memberships);
  for (const sort of [params.products.sort, params.memberships.sort]) if (sort && (sort.key === "cut" || sort.key === "display_price_cents")) throw new HandBackToRails();
  const [products, memberships] = await Promise.all([tableRows(seller, params, "products"), tableRows(seller, params, "memberships")]);
  const rows = [...products.rows, ...memberships.rows];
  const data = await loadRowData(rows);
  await assertThumbnailsSupported(data);
  for (const row of rows) {
    assertPriceSupported(row, data);
    await revenueCut(row, seller.id);
  }
  assertStatsCached(rows, await freshCachedStats(rows));
}

async function rowsData(seller: User, context: SellerContext, rows: LinkRow[]) {
  const data = await loadRowData(rows);
  await assertThumbnailsSupported(data);
  const stats = await freshCachedStats(rows);
  assertStatsCached(rows, stats);
  const collaborating = await collaboratingProductIds(context, rows.map((row) => row.id));
  const owners = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.user_id!))] } } })).map((owner) => [owner.id, owner]));
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    assertPriceSupported(row, data);
    const urls = productUrls(row, owners.get(BigInt(row.user_id!))!);
    result.push({
      id: Number(row.id),
      edit_url: externalEditPath(row),
      name: row.name,
      permalink: row.unique_permalink,
      price_formatted: priceFormattedVerbose(row, data),
      revenue: await totalUsdCentsEarnedByUser(row.id, row.user_id, seller.id),
      thumbnail: thumbnailJson(row, data),
      display_price_cents: displayPriceCents(row, data),
      url: urls.url,
      url_without_protocol: urls.url_without_protocol,
      has_duration: hasDuration(row),
      cut: await revenueCut(row, seller.id),
      can_edit: linkPolicy.edit(context, row, collaborating),
      ...stats.get(row.id)!,
    });
  }
  return result;
}

export async function collabsTableData(seller: User, context: SellerContext, params: ListingParams, kind: Kind) {
  const { pagination, rows } = await tableRows(seller, params, kind);
  return { [kind]: await rowsData(seller, context, rows), pagination, sort: params[kind].sort };
}

// build_stats: every collab of the user, a product with several collaborations counted once per collaboration.
export async function collabsStats(seller: User, params: ListingParams) {
  const { from, where } = collabsQuery(seller.id, params, null);
  const rows = await selectRows<{ id: bigint; user_id: bigint; deleted_at: Date | null; flags: bigint }>(
    Prisma.sql`SELECT links.id AS id, links.user_id AS user_id, links.deleted_at AS deleted_at, links.flags AS flags FROM ${from} WHERE ${where} ORDER BY links.id ASC`,
  );
  let totalRevenue = 0;
  let totalCustomers = 0;
  let totalMembers = 0;
  let totalCollaborations = 0;
  for (const row of rows) {
    if (row.deleted_at === null && !productFlag(row.flags, "archived")) totalCollaborations += 1;
    totalRevenue += await totalUsdCentsEarnedByUser(BigInt(row.id), BigInt(row.user_id), seller.id);
    if (productFlag(row.flags, "is_recurring_billing")) totalMembers += await activeCustomersCount(BigInt(row.id));
    else totalCustomers += await activeCustomersCount(BigInt(row.id));
  }
  return { total_revenue: totalRevenue, total_customers: totalCustomers, total_members: totalMembers, total_collaborations: totalCollaborations };
}

export async function collabsFlags(seller: User, context: SellerContext) {
  return {
    archived_tab_visible: (await archivedProductsCount(seller)) > 0,
    piracy_reports_tab_visible: await piracyReportsTabVisible(context),
    collaborators_disabled_reason: (await hasBrazilianStripeConnectAccount(seller.id)) ? "Collaborators with Brazilian Stripe accounts are not supported." : null,
  };
}
