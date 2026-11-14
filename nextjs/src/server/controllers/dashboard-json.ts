// DashboardController's JSON actions: #customers_count, #total_revenue, #active_members_count, #monthly_recurring_revenue and
// #dismiss_getting_started_checklist. Sellers::BaseController's filters, then the action's `authorize :dashboard`.
import { Prisma } from "@prisma/client";

import { indexName } from "../infra/elasticsearch.ts";
import { formattedDollarAmount } from "../models/concerns/currency-helper.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { findUserBang, setFlag, Users } from "../models/user.ts";
import { dashboardPolicy } from "../policies/dashboard.ts";
import { search } from "../search/api.ts";
import { CHARGED_SALES_SEARCH_OPTIONS } from "../search/creator-analytics-sales.ts";
import type { JsonValue } from "../search/es-json.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { type ActionContext, type ActionOptions, type ActionResult, processAction } from "./application-controller.ts";
import { jsonResponse, type JsonSellerPolicy, sellerJsonAction } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

// Purchase::NON_GIFT_SUCCESS_STATES
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
// Purchase::ACTIVE_SALES_SEARCH_OPTIONS
const ACTIVE_SALES_SEARCH_OPTIONS = {
  state: NON_GIFT_SUCCESS_STATES,
  exclude_refunded_except_subscriptions: true,
  exclude_unreversed_chargedback: true,
  exclude_non_original_subscription_purchases: true,
  exclude_deactivated_subscriptions: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};
// Link flag 2: is_recurring_billing
const IS_RECURRING_BILLING = 2n;

// ActionView::Helpers::NumberHelper#number_with_delimiter
const withDelimiter = (count: number): string => String(count).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

// `products.membership.visible.ids`
async function membershipProductIds(sellerId: bigint): Promise<bigint[]> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "flags")} & ${IS_RECURRING_BILLING} = ${IS_RECURRING_BILLING} ORDER BY ${column("links", "id")}`,
  );
  return rows.map((row) => BigInt(row.id));
}

const aggregationValue = (response: { aggregations?: Record<string, unknown> }, name: string): number => {
  const value = (response.aggregations?.[name] as { value?: number | null } | undefined)?.value;
  if (typeof value !== "number") throw new TypeError("undefined method 'value' for nil");
  return value;
};

async function allSalesCount(sellerId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process({
    seller: Number(sellerId),
    state: NON_GIFT_SUCCESS_STATES,
    exclude_giftees: true,
    exclude_refunded_except_subscriptions: true,
    exclude_unreversed_chargedback: true,
    exclude_non_original_subscription_purchases: true,
    exclude_commission_completion_purchases: true,
    exclude_bundle_product_purchases: true,
    size: 0,
    track_total_hits: true,
  });
  const [imported] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("imported_customers")} WHERE ${column("imported_customers", "importing_user_id")} = ${sellerId} AND ${column("imported_customers", "deleted_at")} IS NULL`,
  );
  return (result.total ?? 0) + Number(imported?.count ?? 0);
}

async function grossSalesCentsTotal(sellerId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process({
    ...CHARGED_SALES_SEARCH_OPTIONS,
    seller: Number(sellerId),
    recommended: null,
    size: 0,
    aggs: {
      price_cents_total: { sum: { field: "price_cents" } },
      amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
    },
  });
  return (
    aggregationValue(result.response, "price_cents_total") -
    aggregationValue(result.response, "amount_refunded_cents_total")
  );
}

async function activeMembersCount(sellerId: bigint): Promise<number> {
  const productIds = await membershipProductIds(sellerId);
  if (productIds.length === 0) return 0;
  const result = await PurchaseSearchService.process({
    ...ACTIVE_SALES_SEARCH_OPTIONS,
    product: productIds.map(Number),
    size: 0,
    track_total_hits: true,
  });
  return result.total ?? 0;
}

async function monthlyRecurringRevenue(sellerId: bigint): Promise<number> {
  const productIds = await membershipProductIds(sellerId);
  if (productIds.length === 0) return 0;
  const result = await PurchaseSearchService.process({
    product: productIds.map(Number),
    state: NON_GIFT_SUCCESS_STATES,
    exclude_non_original_subscription_purchases: true,
    exclude_deactivated_subscriptions: true,
    exclude_cancelled_or_pending_cancellation_subscriptions: true,
    exclude_bundle_product_purchases: true,
    aggs: { mrr_total: { sum: { field: "monthly_recurring_revenue" } } },
    size: 0,
  });
  return aggregationValue(result.response, "mrr_total");
}

const counters = {
  customersCount: async (id: bigint) => withDelimiter(await allSalesCount(id)),
  totalRevenue: async (id: bigint) => formattedDollarAmount(await grossSalesCentsTotal(id)),
  activeMembersCount: async (id: bigint) => withDelimiter(await activeMembersCount(id)),
  monthlyRecurringRevenue: async (id: bigint) => formattedDollarAmount(await monthlyRecurringRevenue(id)),
};

export type DashboardCounter = keyof typeof counters;

export const DASHBOARD_JSON_OPTIONS: ActionOptions = {};

export function dashboardCounterResponse(name: DashboardCounter) {
  return (incoming: Request): Promise<Response> =>
    processAction(incoming, DASHBOARD_JSON_OPTIONS, (action: ActionContext) =>
      sellerJsonAction(action, dashboardPolicy[name] as JsonSellerPolicy, async () =>
        jsonResponse({ success: true, value: await counters[name](action.context.currentSeller!.id) }),
      ),
    );
}

// `current_seller.update!(has_dismissed_getting_started_checklist: true)`, then `head :ok`.
async function dismissGettingStartedChecklist(
  action: Pick<ActionContext, "context" | "request">,
): Promise<ActionResult> {
  return sellerJsonAction(action, dashboardPolicy.dismissGettingStartedChecklist, async () => {
    const seller = await findUserBang(action.context.currentSeller!.id);
    setFlag(seller, "has_dismissed_getting_started_checklist", true);
    await Users.saveBang(seller);
    // `head :ok` answers the request format's bare content type, and never reads the format for a Vary header.
    return { status: 200, body: "", contentType: "application/json", paramsRead: true };
  });
}

registerMutations({
  method: "POST",
  pattern: "/dashboard/dismiss_getting_started_checklist",
  formats: ["json"],
  run: dismissGettingStartedChecklist,
});
