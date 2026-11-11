// Products::AffiliatedController (app/controllers/products/affiliated_controller.rb): an affiliate leaving a seller's program, and
// the Affiliated page's own JSON reload.
//
// #index as JSON (the search, sort and paging of the page, which ask with `Accept: application/json`) is ported whole; the HTML
// page is in server/page-props/seller-products/pages.ts.
//
// Ported: the 404 of an affiliation that is not the signed-in user's own live direct affiliation, and the admin-only policy.
// Handed to Rails before any write: a removal that passes both, which soft-deletes the row and mails the seller.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { authorize } from "../policies/authorize.ts";
import { affiliatedParams, affiliatedProductsProps, assertAffiliatedSupported, canRemoveAffiliations } from "../page-props/seller-products/affiliated.ts";
import { productsAffiliatedDirectAffiliatePolicy, productsAffiliatedPolicy } from "../policies/link.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json } from "./seller-json.ts";

// `DirectAffiliate.alive.where(affiliate_user: current_seller).find_by_external_id(params[:id]) || e404`
async function setDirectAffiliate(input: MutationInput): Promise<void> {
  const id = decrypt(input.routeParams.id ?? "");
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("affiliates", "affiliate_user_id")} = ${input.context.currentSeller!.id} AND ${column("affiliates", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      await setDirectAffiliate(input);
      const denied = await authorizeJson(input, () =>
        authorize(productsAffiliatedDirectAffiliatePolicy.destroy, sellerContext),
      );
      if (denied) return denied;
      throw new HandBackToRails("ending an affiliation soft-deletes the row and mails the seller");
    },
  );
}

registerMutations({ method: "DELETE", pattern: "/products/affiliated/:id", json: true, run: destroy });

// `format.json { render json: props }`. `sort[key]` is read; any other bracketed key is left to Rails (affiliatedParams).
async function index(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, productsAffiliatedPolicy.index, async (sellerContext) => {
    const seller = input.context.currentSeller!;
    const { queryString } = input.request;
    // Hands back an earnings sum Rails caches in the background.
    await assertAffiliatedSupported(seller, queryString);
    return json(await affiliatedProductsProps(seller, sellerContext, affiliatedParams(queryString), canRemoveAffiliations(sellerContext)));
  });
}

registerMutations({ method: "GET", pattern: "/products/affiliated", skipForgeryProtection: true, run: index });
