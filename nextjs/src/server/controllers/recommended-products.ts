// RecommendedProductsController#index (app/controllers/recommended_products_controller.rb): the checkout's "more like this" cards.
//
// Ported: the answer when RecommendedProducts::CheckoutService has no seller to recommend from, which is `[]` before it reads the sales
// index or draws a random sample. That is a request with `recommendation_type=no_recommendations`, or whose cart products belong to no
// seller who allows recommendations (or to none at all). Handed to Rails whole: any cart with a seller to recommend from, whose cards
// come from the sales-related index, a random sample and Elasticsearch, and params Rails rejects or casts in ways Node does not model.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { json } from "./seller-json.ts";

// User::RecommendationType::NO_RECOMMENDATIONS
const NO_RECOMMENDATIONS = "no_recommendations";

// `params.require(:limit).to_i`: a missing or blank limit is a 400, and a negative one makes `take` raise once there are products.
function limitParam(input: MutationInput): number {
  const limit = input.params.limit;
  if (typeof limit !== "string" || limit.trim() === "")
    throw new HandBackToRails("a limit that params.require rejects or that is not text");
  const value = rubyToI(limit);
  if (value < 0) throw new HandBackToRails("a negative limit, which Array#take raises on");
  return value;
}

// `params.fetch(:cart_product_ids, []).map { ObfuscateIds.decrypt(_1) }`: an id that does not decrypt is nil, which matches no product.
function cartProductIds(input: MutationInput): number[] {
  const ids = input.params.cart_product_ids;
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
    throw new HandBackToRails("cart_product_ids that are not a list of text");
  const decrypted = ids.map((id) => decrypt(id)).filter((id): id is number => id !== null);
  if (!decrypted.every(Number.isSafeInteger)) throw new HandBackToRails("an id beyond the safe integer range");
  return decrypted;
}

// CheckoutService#cart_seller_ids, for a recommendation type that is not `no_recommendations`: the sellers of the cart products, minus
// those who opted out when the request names no type.
async function hasCartSeller(ids: number[], recommendationType: string | undefined): Promise<boolean> {
  if (ids.length === 0) return false;
  const optedOut =
    recommendationType === undefined
      ? Prisma.sql` AND ${column("users", "recommendation_type")} != ${NO_RECOMMENDATIONS}`
      : Prisma.empty;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("links", "user_id")} WHERE ${column("links", "id")} IN (${Prisma.join(ids)})${optedOut} LIMIT 1`,
  );
  return rows.length > 0;
}

async function index(input: MutationInput): Promise<ActionResult> {
  // `fetch_recommended_product_infos` builds its arguments in this order.
  const ids = cartProductIds(input);
  limitParam(input);
  const recommendationType = input.params.recommendation_type;
  if (recommendationType !== undefined && typeof recommendationType !== "string")
    throw new HandBackToRails("a recommendation_type that is not text");

  if (recommendationType !== NO_RECOMMENDATIONS && (await hasCartSeller(ids, recommendationType)))
    throw new HandBackToRails("recommendations come from the sales index, a random sample and Elasticsearch");
  return json([]);
}

registerMutations({ method: "GET", pattern: "/recommended_products", skipForgeryProtection: true, run: index });
