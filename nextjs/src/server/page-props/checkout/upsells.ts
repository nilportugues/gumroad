// Checkout::UpsellsController#fetch_upsells and Checkout::UpsellsPresenter: the page, `GET /checkout/upsells/paged` and the lists
// the writes answer with.
import { Prisma, type Upsell } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { parseNestedQuery } from "../../controllers/rails-body.ts";
import { rubyToI } from "../../models/concerns/ruby-numeric.ts";
import { LinkFlags } from "../../models/link.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { IS_CONTENT_UPSELL, UPSELLS, upsellJson } from "../../models/upsell.ts";
import { PurchaseFlags } from "../../search/flags.ts";

export const UPSELLS_PER_PAGE = 20;
const CHECKOUT_DASHBOARD_PAGES = ["discounts", "form", "upsells"];

export type ListParams = { page: number; query: string | null; sortKey: string | null; direction: "asc" | "desc" };

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const CHARGEBACK_REVERSED = PurchaseFlags.bit("chargeback_reversed");

// `params.permit(:page, sort: [:key, :direction])`, `params[:query]`. Anything `permit` or string interpolation would treat
// differently from a scalar goes to Rails.
export function listParams(queryString: string): ListParams {
  const params = parseNestedQuery(queryString);
  const { page, query, sort } = params;
  if (page !== undefined && page !== null && typeof page !== "string")
    throw new HandBackToRails("a page that is not text");
  if (query !== undefined && query !== null && typeof query !== "string")
    throw new HandBackToRails("a query that is not text");
  if (sort !== undefined && !isHash(sort)) throw new HandBackToRails("a sort that is not a hash");
  const { key, direction } = sort ?? {};
  if ((key !== undefined && typeof key !== "string") || (direction !== undefined && typeof direction !== "string"))
    throw new HandBackToRails("a sort key that is not text");
  return {
    page: Math.max(rubyToI(page ?? null), 1),
    query: typeof query === "string" && query.trim() !== "" ? query : null,
    sortKey: typeof key === "string" ? key : null,
    direction: direction === "desc" ? "desc" : "asc",
  };
}

// `Purchase.counts_towards_volume` through upsell_purchases, summed per upsell; NULL for an upsell without such a purchase, which
// MySQL sorts first ascending, as the left outer join does.
const volumeSum = (field: "price_cents" | "quantity") =>
  Prisma.sql`(SELECT SUM(${column("purchases", field)}) FROM ${table("purchases")} INNER JOIN ${table("upsell_purchases")} ON ${column("purchases", "id")} = ${column("upsell_purchases", "purchase_id")} WHERE ${column("upsell_purchases", "upsell_id")} = ${column(UPSELLS, "id")} AND ${column("purchases", "purchase_state")} = 'successful' AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) AND (${column("purchases", "chargeback_date")} IS NULL OR ${column("purchases", "flags")} & ${Prisma.raw(String(CHARGEBACK_REVERSED))} != 0))`;

// `Upsell.sorted_by` (name, revenue, uses and status; any other key is ignored), then `.order(updated_at: :desc)`.
function orderBy(params: ListParams): Prisma.Sql {
  const direction = Prisma.raw(params.direction);
  const updated = Prisma.sql`${column(UPSELLS, "updated_at")} DESC`;
  if (params.sortKey === "name") return Prisma.sql`${column(UPSELLS, "name")} ${direction}, ${updated}`;
  if (params.sortKey === "revenue") return Prisma.sql`${volumeSum("price_cents")} ${direction}, ${updated}`;
  if (params.sortKey === "uses") return Prisma.sql`${volumeSum("quantity")} ${direction}, ${updated}`;
  if (params.sortKey === "status") return Prisma.sql`${column(UPSELLS, "paused")} ${direction}, ${updated}`;
  return updated;
}

export type UpsellsPage = { pagination: { pages: number; page: number }; upsells: Record<string, unknown>[] };

export async function fetchUpsells(sellerId: bigint, params: ListParams): Promise<UpsellsPage> {
  const search =
    params.query === null ? Prisma.empty : Prisma.sql` AND ${column(UPSELLS, "name")} LIKE ${`%${params.query}%`}`;
  const where = Prisma.sql`${column(UPSELLS, "seller_id")} = ${sellerId} AND ${column(UPSELLS, "deleted_at")} IS NULL AND (${column(UPSELLS, "flags")} & ${IS_CONTENT_UPSELL}) = 0${search}`;
  const [counted] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table(UPSELLS)} WHERE ${where}`,
  );
  const pages = Math.max(Math.ceil(Number(counted?.count ?? 0) / UPSELLS_PER_PAGE), 1);
  // config/initializers/pagy.rb: overflow raises Pagy::OverflowError, which no controller rescues: production answers 500.
  if (params.page > pages) throw new Error(`expected :page in 1..${pages}; got ${params.page}`);
  const rows = await selectRows(
    Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${where} ORDER BY ${orderBy(params)} LIMIT ${UPSELLS_PER_PAGE} OFFSET ${(params.page - 1) * UPSELLS_PER_PAGE}`,
  );
  return {
    pagination: { pages, page: params.page },
    upsells: await Promise.all(rows.map((row) => upsellJson(castRow<Upsell>("Upsell", row)))),
  };
}

// Checkout::UpsellsPresenter#product_props
async function productProps(sellerId: bigint) {
  const products = await selectRows<{ id: bigint; name: string | null; native_type: string | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "native_type")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)} ORDER BY ${column("links", "id")}`,
  );
  const multiple = new Set(
    products.length === 0
      ? []
      : (
          await selectRows<{ link_id: bigint }>(
            Prisma.sql`SELECT ${column("variant_categories", "link_id")} AS link_id FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "link_id")} IN (${Prisma.join(products.map((product) => product.id))}) GROUP BY ${column("variant_categories", "link_id")} HAVING COUNT(${column("base_variants", "id")}) > 1`,
          )
        ).map((row) => BigInt(row.link_id)),
  );
  return products.map((product) => ({
    id: encrypt(product.id),
    name: product.name,
    has_multiple_versions: multiple.has(BigInt(product.id)),
    native_type: product.native_type,
  }));
}

export async function upsellsPageProps(sellerId: bigint, params: ListParams) {
  const { pagination, upsells } = await fetchUpsells(sellerId, params);
  return { pages: CHECKOUT_DASHBOARD_PAGES, upsells, pagination, products: await productProps(sellerId) };
}
