// Api::V2::SalesController (app/controllers/api/v2/sales_controller.rb): #resend_receipt, #export (the row and the job; the CSV is built by the worker), and the reads #index and #show, which render
// Purchase#as_json(version: 2) (models/purchase-json.ts). #refund moves money and belongs to phase 2.
import { Prisma } from "@prisma/client";

import { decryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { performAsync } from "../../models/concerns/job-runtime.ts";
import { followingEmails, purchasesAsJsonV2 } from "../../models/purchase-json.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { queueSalesExport, salesExportQuery, type SalesExportFilters } from "../../exports/sales-export.ts";
import { HandBackToRails } from "../application-controller.ts";
import { error400, errorWithObject, fromExternalId, registerApiV2, renderResponse, successWithObject, type ApiV2Input } from "./base.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RESULTS_PER_PAGE = 10;
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

registerApiV2({
  method: "POST",
  pattern: "/v2/sales/:id/resend_receipt",
  scopes: ["edit_sales"],
  async run({ owner, routeParams }) {
    // current_resource_owner.sales.find_by_external_id
    const id = fromExternalId(routeParams.id);
    const [sale] =
      id === null
        ? []
        : await selectRows<{ id: bigint; sender: bigint | number; authorization: bigint | number }>(
            Prisma.sql`SELECT ${column("purchases", "id")}, (CASE WHEN ${PurchaseFlags.condition("is_gift_sender_purchase", true)} THEN 1 ELSE 0 END) AS sender, (CASE WHEN ${PurchaseFlags.condition("is_preorder_authorization", true)} THEN 1 ELSE 0 END) AS authorization FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${owner.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
          );
    if (sale === undefined) return errorWithObject("sale");
    // A preorder authorization sends a CustomerMailer.preorder_receipt and a gift sender also the giftee's receipt.
    if (Number(sale.authorization) === 1 || Number(sale.sender) === 1) throw new HandBackToRails("a preorder authorization or gift sender receipt");

    await performAsync("SendPurchaseReceiptJob", [Number(sale.id), true]);
    return renderResponse(true);
  },
});

// Date.strptime(value, "%Y-%m-%d"): a real calendar date, or ArgumentError. Ruby ignores text after the matched day ("2026-11-03 02:54:08 UTC").
function strptimeDate(value: unknown): { date: string } | { invalid: true } {
  if (typeof value !== "string") throw new HandBackToRails("a date parameter that is not text");
  const match = /^(\d{4})-(\d\d?)-(\d\d?)/u.exec(value);
  if (match === null) {
    // %Y reads a sign and any number of digits, and leading space is skipped: only plain failures are answered here
    if (/^[\s+-]|^\d{1,3}-|^\d{5,}-/u.test(value)) throw new HandBackToRails("a date spelling strptime reads loosely");
    return { invalid: true };
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1000) throw new HandBackToRails("a year before 1000");
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return { invalid: true };
  return { date: `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

// export_filters: a date goes on to Date.parse, which agrees with the strptime check for these spellings only
const EXPORT_DATE = /^\d{4}-\d{1,2}-\d{1,2}(?: (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)?$/u;

async function exportSales({ owner, params }: ApiV2Input) {
  const filters: SalesExportFilters = {};
  for (const [param, key] of [["from", "startDate"], ["to", "endDate"]] as const) {
    const value = params[param];
    if (value === undefined || value === null || (typeof value === "string" && !present(value))) continue;
    const parsed = strptimeDate(value);
    if ("invalid" in parsed) return error400(`Invalid date format provided in field '${param}'. Dates must be in the format YYYY-MM-DD.`);
    if (!EXPORT_DATE.test(value as string)) throw new HandBackToRails("a date spelling Date.parse reads differently");
    filters[key] = parsed.date;
  }
  const productParam = params.product_id;
  if (productParam !== undefined && productParam !== null && (typeof productParam !== "string" || present(productParam))) {
    if (typeof productParam !== "string") throw new HandBackToRails("a product_id that is not text");
    const id = fromExternalId(productParam);
    const [product] = id === null ? [] : await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${owner.id} AND ${column("links", "id")} = ${id} LIMIT 1`);
    if (product === undefined) return error400("Invalid product ID.");
    filters.productIds = [Number(product.id)];
  }
  await queueSalesExport(owner.id, salesExportQuery(owner.id, filters));
  return renderResponse(true, { status: "queued", recipient_email: owner.email });
}

// String#to_i
const rubyToI = (value: string): number => {
  const match = /^\s*[-+]?\d[\d_]*/u.exec(value);
  return match ? Number(match[0].replaceAll("_", "")) : 0;
};

// Purchase.sanitize_sql_like
const sanitizeSqlLike = (value: string) => value.replace(/[\\%_]/gu, (char) => `\\${char}`);

const selectSales = (where: Prisma.Sql, tail: Prisma.Sql) =>
  selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")}, DATE_FORMAT(${column("purchases", "created_at")}, ${USEC_FORMAT}) AS created_usec FROM ${table("purchases")} WHERE ${where}${tail}`);

async function saleJson(rows: Row[], sellerId: bigint, listed: boolean): Promise<Record<string, unknown>[]> {
  if (!listed) return purchasesAsJsonV2(rows);
  const following = await followingEmails(sellerId, [...new Set(rows.map((row) => String(row.email)))]);
  return purchasesAsJsonV2(rows, { isFollowing: (row) => following.has(String(row.email ?? "").toLowerCase()) });
}

async function show({ owner, routeParams }: ApiV2Input) {
  const id = fromExternalId(routeParams.id);
  const [sale] = id === null ? [] : await selectSales(Prisma.sql`${column("purchases", "seller_id")} = ${owner.id} AND ${column("purchases", "id")} = ${id}`, Prisma.sql` LIMIT 1`);
  if (sale === undefined) return errorWithObject("sale");
  return successWithObject("sale", (await saleJson([sale], owner.id, false))[0]);
}

async function index({ owner, params, request }: ApiV2Input) {
  const rawPage = params.page;
  const deprecatedPage = rawPage !== undefined && rawPage !== null;
  let page = 1;
  // set_page: an Integer or String is read with to_i; anything else (a nested param) is the first page
  if (typeof rawPage === "string") page = rubyToI(rawPage);
  else if (typeof rawPage === "number") page = Math.trunc(rawPage);
  if (!(page > 0)) return error400("Invalid page number. Page numbers start at 1.");
  for (const key of ["before", "after", "email", "name", "license_key", "product_id", "order_id", "page_key"]) {
    const value = params[key];
    if (value !== undefined && value !== null && typeof value !== "string") throw new HandBackToRails(`a non-text ${key} parameter`);
  }

  const conditions: Prisma.Sql[] = [Prisma.sql`${column("purchases", "seller_id")} = ${owner.id}`];
  if (params.before !== undefined && params.before !== null) {
    const parsed = strptimeDate(params.before);
    if ("invalid" in parsed) return error400("Invalid date format provided in field 'before'. Dates must be in the format YYYY-MM-DD.");
    conditions.push(Prisma.sql`${column("purchases", "created_at")} < ${parsed.date}`);
  }
  if (params.after !== undefined && params.after !== null) {
    const parsed = strptimeDate(params.after);
    if ("invalid" in parsed) return error400("Invalid date format provided in field 'after'. Dates must be in the format YYYY-MM-DD.");
    conditions.push(Prisma.sql`${column("purchases", "created_at")} >= ${parsed.date}`);
  }
  if (present(params.product_id)) {
    const productId = fromExternalId(params.product_id);
    // ObfuscateIds.decrypt fails silently on bad base64; a wider result set would be wrong
    if (productId === null) return error400("Invalid product ID.");
    conditions.push(Prisma.sql`${column("purchases", "link_id")} = ${productId}`);
  }
  if (present(params.order_id)) {
    if (String(rubyToI(params.order_id)) !== params.order_id) return error400("Invalid order ID.");
    conditions.push(Prisma.sql`${column("purchases", "id")} = ${decryptNumeric(rubyToI(params.order_id))}`);
  }
  if (present(params.email)) conditions.push(Prisma.sql`${column("purchases", "email")} = ${params.email.trim()}`);
  if (present(params.name)) conditions.push(Prisma.sql`${column("purchases", "full_name")} LIKE ${`%${sanitizeSqlLike(params.name.trim())}%`}`);
  if (present(params.license_key)) {
    // sale_ids_for_license_key: the gifter's purchase when the license sits on a giftee purchase
    conditions.push(
      Prisma.sql`${column("purchases", "id")} IN (SELECT COALESCE(gifts.gifter_purchase_id, purchases.id) FROM purchases LEFT JOIN gifts ON gifts.giftee_purchase_id = purchases.id WHERE purchases.id IN (SELECT purchase_id FROM licenses WHERE serial = ${params.license_key.trim().toUpperCase()}))`,
    );
  }
  // for_sales_api / the successful and free-trial subqueries of for_sales_api_ordered_by_date
  conditions.push(
    Prisma.sql`${column("purchases", "purchase_state")} IN ('successful', 'not_charged') AND (${column("purchases", "purchase_state")} != 'not_charged' OR ${PurchaseFlags.condition("is_free_trial_purchase", true)})`,
  );
  const order = Prisma.sql` ORDER BY ${column("purchases", "created_at")} DESC, ${column("purchases", "id")} DESC`;

  let tail: Prisma.Sql;
  if (deprecatedPage) {
    tail = Prisma.sql`${order} LIMIT ${RESULTS_PER_PAGE + 1} OFFSET ${(page - 1) * RESULTS_PER_PAGE}`;
  } else {
    if (present(params.page_key)) {
      const decoded = decodePageKey(params.page_key);
      if (decoded === null) return error400("Invalid page_key.");
      conditions.push(Prisma.sql`${column("purchases", "created_at")} <= ${decoded.at} AND ${column("purchases", "id")} < ${decoded.id}`);
    }
    tail = Prisma.sql`${order} LIMIT ${RESULTS_PER_PAGE + 1}`;
  }
  const rows = await selectSales(Prisma.join(conditions.map((condition) => Prisma.sql`(${condition})`), " AND "), tail);
  const more = rows.length > RESULTS_PER_PAGE;
  const sales = await saleJson(rows.slice(0, RESULTS_PER_PAGE), owner.id, true);
  return successWithObject("sales", sales, more ? paginationInfo(request, rows[RESULTS_PER_PAGE - 1] as { created_usec: string; id: bigint }) : {});
}

registerApiV2(
  { method: "POST", pattern: "/v2/sales/exports", scopes: ["view_sales"], run: exportSales },
  { method: "GET", pattern: "/v2/sales", scopes: ["view_sales"], run: index },
  // Rails routes /v2/sales/summary ahead of /v2/sales/:id; until the summary is served it must not be read as a sale id.
  {
    method: "GET",
    pattern: "/v2/sales/summary",
    scopes: ["view_sales"],
    async run() {
      throw new HandBackToRails("the sales summary");
    },
  },
  { method: "GET", pattern: "/v2/sales/:id", scopes: ["view_sales"], run: show },
);
