// Checkout::Upsells::ProductsController (app/controllers/checkout/upsells/products_controller.rb): #index and #show run in Node.
//
// Handed to Rails: a non-text `query`, a product with no price or currency (Rails raises on `.downcase`) and a thumbnail that is an
// uploaded file (Active Storage variants and the CDN rewrite are not ported). The 10 second query timeout is not reproduced.
import { Prisma } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { thumbnailOrCoverUrl } from "../page-props/buyer/products.ts";
import { linkOptions, listedPriceCents } from "../presenters/product-props.ts";
import { reviewStat, userByDomain, type LinkRow } from "../presenters/product-reads.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const MAX_PRODUCTS = 25;
const ARCHIVED = Prisma.raw(String(LinkFlags.bit("archived")));
const TIERED_MEMBERSHIP = Prisma.raw(String(LinkFlags.bit("is_tiered_membership")));

// Link.sanitize_sql_like
const sanitizeSqlLike = (value: string) => value.replace(/[\\%_]/gu, "\\$&");

// Link.eligible_for_content_upsells: visible_and_not_archived.not_is_tiered_membership
const eligible = Prisma.sql`${column("links", "deleted_at")} IS NULL AND (${column("links", "flags")} & ${ARCHIVED}) = 0 AND (${column("links", "flags")} & ${TIERED_MEMBERSHIP}) = 0`;

// Checkout::Upsells::ProductPresenter#product_props
async function productProps(row: LinkRow) {
  const priceCents = await listedPriceCents(row);
  if (priceCents === null || row.price_currency_type === null)
    throw new HandBackToRails("a product with no price or currency");
  const stat = await reviewStat(row.id);
  return {
    id: encrypt(row.id),
    permalink: row.unique_permalink,
    name: row.name,
    price_cents: priceCents,
    currency_code: row.price_currency_type.toLowerCase(),
    review_count: Number(stat?.reviews_count ?? 0),
    average_rating: Number(stat?.average_rating ?? 0),
    native_type: row.native_type,
    thumbnail_url: await thumbnailOrCoverUrl(row.id),
    options: await linkOptions(row),
  };
}

export async function index(input: MutationInput): Promise<ActionResult> {
  const query = input.params.query;
  if (query !== undefined && query !== null && typeof query !== "string")
    throw new HandBackToRails("a query that is not text");
  const sellerId = (await userByDomain(input.request.host))?.id ?? input.context.currentSeller?.id;
  if (sellerId === undefined) return jsonResponse([], 200, false);

  // The picker lists variants as "Product (Variant)", so the search matches the names of the product's alive versions too.
  const pattern = query === undefined || query === null ? "" : `%${sanitizeSqlLike(query)}%`;
  const search =
    query === undefined || query === null || query.trim() === ""
      ? Prisma.empty
      : Prisma.sql` AND (${column("links", "name")} LIKE ${pattern} OR EXISTS (SELECT 1 FROM ${table("variant_categories")} INNER JOIN ${table("base_variants")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("variant_categories", "link_id")} = ${column("links", "id")} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "name")} LIKE ${pattern}))`;
  const rows = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${eligible}${search} ORDER BY ${column("links", "created_at")} DESC, ${column("links", "id")} DESC LIMIT ${MAX_PRODUCTS}`,
  );
  const props = [];
  for (const row of rows) props.push(await productProps(row));
  return jsonResponse(props, 200, true);
}

async function show(input: MutationInput): Promise<ActionResult> {
  const id = decrypt(input.routeParams.id ?? "");
  const [row] =
    id === null
      ? []
      : await selectRows<LinkRow>(
          Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} AND ${eligible} LIMIT 1`,
        );
  if (row === undefined) throw new RoutingError("Not Found");
  return jsonResponse(await productProps(row), 200, true);
}

registerMutations(
  { method: "GET", pattern: "/checkout/upsells/products", skipForgeryProtection: true, run: index },
  { method: "GET", pattern: "/checkout/upsells/products/:id", skipForgeryProtection: true, run: show },
);
