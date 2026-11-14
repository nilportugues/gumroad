// AffiliatesController#statistics and DirectAffiliate#product_sales_info: what an affiliate has sold, per product. Seller JSON, reads only.
import { Prisma } from "@prisma/client";

import { decrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { findDirectAffiliate } from "../page-props/dashboard/affiliates.ts";
import { authorize } from "../policies/authorize.ts";
import { directAffiliatePolicy } from "../policies/direct-affiliate.ts";
import { esJson } from "../search/es-json.ts";

import { type ActionContext, type ActionResult, processAction, RoutingError } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { authorizeJson } from "./seller-json.ts";

export type ProductSales = { linkId: number; volumeCents: number; salesCount: number };

// The products keep the order the group-by returned them in, which a JS object with integer-like keys would not.
export function statisticsBody(sales: ProductSales[]): string {
  const totalVolumeCents = sales.reduce((sum, { volumeCents }) => sum + volumeCents, 0);
  const products = sales
    .map(
      ({ linkId, volumeCents, salesCount }) =>
        `${JSON.stringify(String(encryptNumeric(linkId)))}:${esJson({ volume_cents: volumeCents, sales_count: salesCount })}`,
    )
    .join(",");
  return `{"total_volume_cents":${totalVolumeCents},"products":{${products}}}`;
}

// `affiliate_credits.joins(:purchase).merge(Purchase.counts_towards_volume)` over the products the affiliate is assigned.
async function productSalesInfo(affiliateId: number): Promise<ProductSales[]> {
  const rows = await selectRows<{ link_id: number; volume_cents: bigint; sales_count: bigint }>(
    Prisma.sql`SELECT ${column("affiliate_credits", "link_id")} AS link_id, CAST(SUM(purchases.price_cents) AS SIGNED) AS volume_cents, COUNT(purchases.id) AS sales_count
      FROM ${table("affiliate_credits")} INNER JOIN ${table("purchases")} ON purchases.id = affiliate_credits.purchase_id
      WHERE ${column("affiliate_credits", "affiliate_id")} = ${affiliateId}
        AND ${column("affiliate_credits", "link_id")} IN (SELECT ${column("links", "id")} FROM ${table("affiliates_links")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("affiliates_links", "link_id")} WHERE ${column("affiliates_links", "affiliate_id")} = ${affiliateId})
        AND purchases.purchase_state = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)
        AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0))
      GROUP BY ${column("affiliate_credits", "link_id")}`,
  );
  return rows.map((row) => ({
    linkId: Number(row.link_id),
    volumeCents: Number(row.volume_cents),
    salesCount: Number(row.sales_count),
  }));
}

async function statistics(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  return sellerJsonAction(
    action,
    () => true,
    async (sellerContext) => {
      const id = decrypt(routeParams.id ?? "");
      const affiliate = id === null ? null : await findDirectAffiliate(sellerContext.seller!.id, id);
      if (affiliate === null) throw new RoutingError("Not Found");
      const denied = await authorizeJson(action, (context) => authorize(directAffiliatePolicy.statistics, context));
      if (denied) return denied;
      return { ...jsonResponse(null, 200, true), body: statisticsBody(await productSalesInfo(affiliate.id)) };
    },
  );
}

export const affiliateStatisticsResponse = (
  incoming: Request,
  params: Promise<Record<string, string>>,
): Promise<Response> =>
  params.then((routeParams) => processAction(incoming, {}, (action) => statistics(action, routeParams)));
