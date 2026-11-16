// PublicController#charge_data, #license_key_lookup_data and #paypal_charge_data: the JSON the lookup pages post their form to.
// Each one only looks purchases up and enqueues the receipt mail.
import { Prisma } from "@prisma/client";

import { performAsync } from "../models/concerns/job-runtime.ts";
import { rubyUriParseParts } from "../models/concerns/ruby-uri.ts";
import { selectRows, column, table, inList } from "../models/sql.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { deliverLater, keywordArgs } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { rackParam } from "../page-props/audience/support.ts";
import { esJson } from "../search/es-json.ts";
import { idFromExternalId } from "./buyer-pages.ts";
import { HandBackToRails, type Rendered } from "./application-controller.ts";
import { assertFlatQuery } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

const EARLIEST_PURCHASE_YEAR = 2011;
const CARD_SUFFIX_LENGTH = 4;
const SUCCESSFUL_STATES = ["successful", "gift_receiver_purchase_successful"];
const CUSTOMER_MAILER = "CustomerMailer";

const json = (value: { success: boolean }): Rendered => ({ status: 200, body: esJson(value), contentType: "application/json; charset=utf-8", paramsRead: true });

// Rails' `?email[]=a` arrives as a list, and the controller reads it as absent: a shape the port leaves to Rails.
function scalarParam(request: RailsRequest, name: string): string | null {
  const value = rackParam(request, name);
  return typeof value === "string" ? value : null;
}

// String#to_i
const rubyToI = (value: string): number => {
  const match = /^\s*([+-]?\d[\d_]*)/u.exec(value);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
};

// PublicController#scope_by_year_and_month: a month only applies with a year.
function createdAtRange(request: RailsRequest, now: Date): Prisma.Sql {
  const year = rubyToI(String(rackParam(request, "year") ?? ""));
  if (year < EARLIEST_PURCHASE_YEAR || year > now.getUTCFullYear()) return Prisma.empty;
  const month = rubyToI(String(rackParam(request, "month") ?? ""));
  const start = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month - 1)) : new Date(Date.UTC(year, 0));
  const end = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month)) : new Date(Date.UTC(year + 1, 0));
  const sql = (time: Date) => time.toISOString().replace("T", " ").replace("Z", "");
  return Prisma.sql` AND ${column("purchases", "created_at")} >= ${sql(start)} AND ${column("purchases", "created_at")} < ${sql(end)}`;
}

const emailScope = (email: string | null) => Prisma.sql`${column("purchases", "purchase_state")} IN ${inList(SUCCESSFUL_STATES)} AND ${column("purchases", "email")} = ${email}`;

async function purchaseIds(scope: Prisma.Sql, joins = Prisma.empty): Promise<bigint[]> {
  const rows = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")}${joins} WHERE ${scope} ORDER BY ${column("purchases", "id")} ASC`);
  return rows.map((row) => row.id);
}

const sendGroupedReceipt = (ids: bigint[], recommendations?: boolean) =>
  deliverLater(
    currentJobsRuntime(),
    { mailer: CUSTOMER_MAILER, method: "grouped_receipt", args: [ids.map(Number), ...(recommendations === undefined ? [] : [keywordArgs({ recommendations })])], queue: "critical" },
    mailRoute(CUSTOMER_MAILER, "grouped_receipt"),
  );

export async function chargeData(request: RailsRequest, now = new Date()): Promise<Rendered> {
  assertFlatQuery(request.queryString);
  const last4 = scalarParam(request, "last_4");
  let scope = emailScope(scalarParam(request, "email"));
  if (last4 !== null && last4 !== "" && last4.length === CARD_SUFFIX_LENGTH) scope = Prisma.sql`${scope} AND ${column("purchases", "card_visual")} LIKE ${`%${last4}%`}`;
  const ids = await purchaseIds(Prisma.sql`${scope}${createdAtRange(request, now)}`);
  if (ids.length === 0) return json({ success: false });
  await sendGroupedReceipt(ids);
  return json({ success: true });
}

// PublicController#extract_permalink_from_query
function extractPermalink(query: string): string {
  if (!/^https?:\/\//iu.test(query) && !query.includes("/")) return query;
  let path: string | null;
  try {
    path = rubyUriParseParts(query).path;
  } catch {
    path = query;
  }
  return (path ?? "").split("/").reverse().find((segment) => /[^\s]/u.test(segment)) ?? query;
}

// ActiveRecord::Base.sanitize_sql_like
const sanitizeLike = (value: string) => value.replace(/[\\%_]/gu, (char) => `\\${char}`);

export async function licenseKeyLookupData(request: RailsRequest, now = new Date()): Promise<Rendered> {
  assertFlatQuery(request.queryString);
  const base = Prisma.sql`${emailScope(scalarParam(request, "email"))}${createdAtRange(request, now)}`;
  let ids = await purchaseIds(base);
  let recommendations = true;
  const productQuery = scalarParam(request, "product_query");
  if (productQuery !== null && /[^\s]/u.test(productQuery)) {
    const query = extractPermalink(productQuery.trim());
    const joins = Prisma.sql` INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("purchases", "link_id")}`;
    const scoped = await purchaseIds(
      Prisma.sql`${base} AND (links.name LIKE ${`%${sanitizeLike(query)}%`} OR links.unique_permalink = ${query} OR links.custom_permalink = ${query})`,
      joins,
    );
    // The full set stands in for no match: a caller who knows the email must not learn whether it bought a given product.
    if (scoped.length > 0) {
      ids = scoped;
      recommendations = false;
    }
  }
  if (ids.length === 0) return json({ success: false });
  await sendGroupedReceipt(ids, recommendations);
  return json({ success: true });
}

export async function paypalChargeData(request: RailsRequest): Promise<Rendered> {
  assertFlatQuery(request.queryString);
  // `?invoice_id` without a value is nil in Rack, "" in the port's reader.
  if (/(?:^|&)invoice_id(?:&|$)/u.test(request.queryString)) throw new HandBackToRails();
  const invoiceId = rackParam(request, "invoice_id");
  if (invoiceId === undefined) return json({ success: false });
  const id = typeof invoiceId === "string" ? await idFromExternalId(invoiceId) : null;
  const [purchase] = id === null ? [] : await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`);
  if (purchase === undefined) return json({ success: false });
  await performAsync("SendPurchaseReceiptJob", [Number(purchase.id)]);
  return json({ success: true });
}
