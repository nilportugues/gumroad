// What the sales analytics pages read about a seller: the products analytics lists, the first sale and the
// local calendar day.
import { Prisma, type User } from "@prisma/client";

import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { civilDateInZone, timezoneId } from "../../search/civil-time.ts";

// Purchase::CHARGED_SUCCESS_STATES
const CHARGED_SUCCESS_STATES = ["preorder_authorization_successful", "successful"];

export type AnalyticsProduct = { id: bigint; name: string | null; unique_permalink: string | null; deleted_at: Date | null; flags: bigint };

// User#products_for_creator_analytics: products deleted or archived without any successful sale are omitted.
// Newest first.
export async function productsForCreatorAnalytics(sellerId: bigint): Promise<AnalyticsProduct[]> {
  return await selectRows<AnalyticsProduct>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "unique_permalink")}, ${column("links", "deleted_at")}, ${column("links", "flags")} FROM ${table("links")}
      WHERE ${column("links", "user_id")} = ${sellerId}
      AND (EXISTS (SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "purchase_state")} IN (${Prisma.join(CHARGED_SUCCESS_STATES)}) AND purchases.link_id = links.id)
        OR (${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)}))
      ORDER BY ${column("links", "id")} DESC`,
  );
}

// User#first_sale_created_at_for_analytics: the earliest successful, authorized-preorder or concluded-preorder sale.
export async function firstSaleCreatedAtForAnalytics(sellerId: bigint): Promise<Date | null> {
  const states = ["successful", "preorder_authorization_successful", "preorder_concluded_successfully"];
  const unions = states.map(
    (state) => Prisma.sql`(SELECT ${column("purchases", "created_at")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "purchase_state")} = ${state} ORDER BY ${column("purchases", "created_at")} ASC LIMIT 1)`,
  );
  const [row] = await selectRows<{ created_at: Date }>(Prisma.sql`SELECT created_at FROM (${Prisma.join(unions, " UNION ")}) subquery ORDER BY created_at ASC LIMIT 1`);
  return row?.created_at ?? null;
}

// `Time.current.in_time_zone(seller.timezone).to_date`
export const sellerToday = (seller: Pick<User, "timezone">, now: Date = new Date()): string => civilDateInZone(now.getTime(), timezoneId(seller.timezone));

// `time.in_time_zone(seller.timezone).to_date`
export const sellerDate = (seller: Pick<User, "timezone">, time: Date): string => civilDateInZone(time.getTime(), timezoneId(seller.timezone));
