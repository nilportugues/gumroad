// Port of app/controllers/api/mobile/products_controller.rb#index.
//
// Served here: the seller's visible, unarchived products newest first (name filter, 20 a page) for the shapes the dashboard row
// serializer reproduces (USD, buy-only, cached stats not needed), and the 400 Pagy::OverflowError renders for a page past the last
// one. Everything else goes to Rails whole: a page or query Ruby casts differently, a product priced in another currency or with an uploaded
// thumbnail. #destroy soft-deletes the product and records the delete event in Node; a delete while a staff member impersonates the seller
// (Rails records no event) or one the policy refuses goes to Rails whole.
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { LinkFlags, Links } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { createUserEvent } from "../page-props/audience/events.ts";
import {
  assertPriceSupported,
  assertThumbnailsSupported,
  loadRowData,
  priceFormattedVerbose,
  productFlag,
  thumbnailJson,
  type LinkRow,
} from "../page-props/seller-products/listing.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails } from "./application-controller.ts";
import { fetchError, registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";
import { deleteProductBang } from "./products-mutations.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
// Api::Mobile::ProductsController::PRODUCTS_PER_PAGE
const PRODUCTS_PER_PAGE = 20;
const FIRST_PAGE = 1;
const DIGITS = /^\d{1,9}$/u;

// Link.sanitize_sql_like
const sanitizeSqlLike = (value: string) => value.replace(/[\\%_]/gu, "\\$&");

// `[params[:page].to_i, 1].max` for the shapes whose to_i is plain digits (a negative number is 1 too, but Ruby decides the rest).
function pageParam(value: unknown): number {
  if (value === undefined || value === null || value === "") return FIRST_PAGE;
  if (typeof value === "string" && DIGITS.test(value)) return Math.max(Number(value), FIRST_PAGE);
  throw new HandBackToRails("a page Node does not cast");
}

// ProductsController#product_json over DashboardProductsPagePresenter#product_props
function productJson(
  row: LinkRow,
  context: SellerContext,
  data: Awaited<ReturnType<typeof loadRowData>>,
  collaborating: ReadonlySet<bigint>,
) {
  assertPriceSupported(row, data);
  return {
    id: row.unique_permalink,
    name: row.name,
    permalink: row.unique_permalink,
    price_formatted: priceFormattedVerbose(row, data),
    status: status(row),
    thumbnail_url: thumbnailJson(row, data)?.url ?? null,
    can_edit: linkPolicy.edit(context, row, collaborating),
    can_destroy: linkPolicy.destroy(context),
  };
}

// DashboardProductsPagePresenter#product_status
function status(row: LinkRow): string {
  if (row.draft || row.purchase_disabled_at) return "unpublished";
  return productFlag(row.flags, "is_in_preorder_state") ? "preorder" : "published";
}

async function index(input: MobileInput, auth: MobileAuth | null) {
  const seller = auth!.owner;
  const page = pageParam(input.params.page);
  const query = input.params.query;
  if (query !== undefined && query !== null && typeof query !== "string")
    throw new HandBackToRails("a query that is not a string");

  // current_resource_owner.products.visible.not_archived, plus the name filter when `query.present?`
  const nameFilter =
    typeof query === "string" && query.trim() !== ""
      ? Prisma.sql` AND ${column("links", "name")} LIKE ${`%${sanitizeSqlLike(query)}%`}`
      : Prisma.empty;
  const where = Prisma.sql`${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)}${nameFilter}`;
  const [counted] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("links")} WHERE ${where}`,
  );
  const count = Number(counted?.count ?? 0);
  const pages = Math.max(Math.ceil(count / PRODUCTS_PER_PAGE), 1);
  // Api::Mobile::BaseController rescues Pagy::VariableError (config/initializers/pagy.rb sets overflow to :exception)
  if (page > pages)
    return { ...renderJson({ error: { message: `expected :page in 1..${pages}; got ${page}` } }, 400), rescued: true };

  const ids = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${where} ORDER BY ${column("links", "created_at")} DESC, ${column("links", "id")} DESC LIMIT ${PRODUCTS_PER_PAGE} OFFSET ${(page - 1) * PRODUCTS_PER_PAGE}`,
  );
  const found = await db.link.findMany({ where: { id: { in: ids.map((row) => BigInt(row.id)) } } });
  const byId = new Map(found.map((row) => [row.id, row]));
  const rows = ids.flatMap((row) => byId.get(BigInt(row.id)) ?? []);

  // SellerContext.new(user: current_resource_owner, seller: current_resource_owner)
  const context: SellerContext = { user: seller, seller, memberships: [] };
  const data = await loadRowData(rows);
  await assertThumbnailsSupported(data);
  const collaborating = await collaboratingProductIds(
    context,
    rows.map((row) => row.id),
  );
  return renderJson({
    success: true,
    products: rows.map((row) => productJson(row, context, data, collaborating)),
    pagination: { count, page, pages, next: page < pages ? page + 1 : null },
  });
}

const DELETE_EVENT = "delete_product_mobile_app";

async function destroy(input: MobileInput, auth: MobileAuth | null) {
  const seller = auth!.owner;
  // Events#create_event returns while impersonating, so Rails deletes without recording the event.
  if (auth!.impersonated !== null) throw new HandBackToRails("a delete while impersonating");
  // current_resource_owner.products.visible.find_by(unique_permalink:)
  const row = await db.link.findFirst({
    where: { user_id: seller.id, deleted_at: null, unique_permalink: input.routeParams.id },
  });
  if (row === null) return fetchError("Product not found");
  const context: SellerContext = { user: seller, seller, memberships: [] };
  if (!linkPolicy.destroy(context)) throw new HandBackToRails("a product the policy does not let the seller delete");

  await deleteProductBang(seller.id, Links.load(row));
  await createUserEvent(DELETE_EVENT, {
    context: { loggedInUser: null, currentSeller: null, impersonatedUser: null },
    headers: input.request.headers,
    url: input.url,
    // Rails mints a guid per request for a client that sends no cookie, and the event row keeps it.
    state: { mobileParam: undefined, signupReferrer: undefined, mintedGuid: randomUUID() },
    params: input.params,
    product: { id: row.id, price_cents: row.price_cents },
    userId: seller.id,
  });
  return renderJson({ success: true });
}

registerMobile(
  { method: "GET", pattern: "/mobile/products", scopes: MOBILE_API_SCOPES, run: index },
  { method: "DELETE", pattern: "/mobile/products/:id", scopes: MOBILE_API_SCOPES, run: destroy },
);
