// Products::AffiliatedController (app/controllers/products/affiliated_controller.rb): an affiliate leaving a seller's program, and
// the Affiliated page's own JSON reload.
//
// #index as JSON (the search, sort and paging of the page, which ask with `Accept: application/json`) is ported whole; the HTML
// page is in server/page-props/seller-products/pages.ts.
//
// Ported: the 404 of an affiliation that is not the signed-in user's own live direct affiliation, and the admin-only policy.
// A removal that passes both runs in Node: the conditional UPDATE that wins the transition (no callbacks, no validations), the mail to the
// seller, and the page props. The earnings sum Rails caches in the background (`assertAffiliatedSupported`) hands back before the UPDATE.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import {
  affiliatedParams,
  affiliatedProductsProps,
  assertAffiliatedSupported,
  canRemoveAffiliations,
} from "../page-props/seller-products/affiliated.ts";
import { authorize } from "../policies/authorize.ts";
import { productsAffiliatedDirectAffiliatePolicy, productsAffiliatedPolicy } from "../policies/link.ts";

import { RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json } from "./seller-json.ts";

// `DirectAffiliate.alive.where(affiliate_user: current_seller).find_by_external_id(params[:id]) || e404`
async function setDirectAffiliate(input: MutationInput): Promise<number> {
  const id = decrypt(input.routeParams.id ?? "");
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("affiliates", "affiliate_user_id")} = ${input.context.currentSeller!.id} AND ${column("affiliates", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  return id!;
}

// DirectAffiliate.set_removed_at_request_sql: `has_flags 4 => :removed_at_request`
const REMOVED_AT_REQUEST = 8;
const AFFILIATE_MAILER = "AffiliateMailer";
const REMOVAL_BY_AFFILIATE_MAIL = "direct_affiliate_removal_by_affiliate_user";

async function destroy(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const affiliateId = await setDirectAffiliate(input);
      const denied = await authorizeJson(input, () =>
        authorize(productsAffiliatedDirectAffiliatePolicy.destroy, sellerContext),
      );
      if (denied) return denied;
      const seller = input.context.currentSeller!;
      const { queryString } = input.request;
      // The page props below read the earnings Rails caches in the background; refuse that before the UPDATE.
      await assertAffiliatedSupported(seller, queryString);

      // `DirectAffiliate.alive.where(id:).update_all(...)`: the conditional UPDATE is the gate, so the loser of a race 404s.
      const now = new Date();
      const removed = await execute(
        Prisma.sql`UPDATE ${table("affiliates")} SET ${column("affiliates", "deleted_at")} = ${now}, ${column("affiliates", "updated_at")} = ${now}, ${column("affiliates", "flags")} = ${column("affiliates", "flags")} | ${REMOVED_AT_REQUEST} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "id")} = ${affiliateId} AND ${column("affiliates", "deleted_at")} IS NULL`,
      );
      if (removed === 0) throw new RoutingError("Not Found");

      await deliverLater(
        currentJobsRuntime(),
        { mailer: AFFILIATE_MAILER, method: REMOVAL_BY_AFFILIATE_MAIL, args: [affiliateId] },
        mailRoute(AFFILIATE_MAILER, REMOVAL_BY_AFFILIATE_MAIL),
      );
      return json(
        await affiliatedProductsProps(
          seller,
          sellerContext,
          affiliatedParams(queryString),
          canRemoveAffiliations(sellerContext),
        ),
      );
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
    return json(
      await affiliatedProductsProps(
        seller,
        sellerContext,
        affiliatedParams(queryString),
        canRemoveAffiliations(sellerContext),
      ),
    );
  });
}

registerMutations({ method: "GET", pattern: "/products/affiliated", skipForgeryProtection: true, run: index });
