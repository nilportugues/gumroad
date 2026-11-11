// The guards of the writes behind the checkout dashboard and the Customers page: Checkout::DiscountsController#create, #update and
// #destroy, Checkout::UpsellsController#create and #update, Purchases::PingsController#create and Purchases::VariantsController#update.
//
// Ported: the 404 of an unknown record and the Pundit refusals (answered as JSON). Handed to Rails whole, before any write: whatever
// passes them. The writes run OfferCode and SaveUpsellService validations and callbacks, send the ping webhook, or move a
// purchase to another option.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { checkoutOfferCodePolicy } from "../policies/checkout-offer-code.ts";
import { checkoutUpsellPolicy } from "../policies/checkout-upsell.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { findUpsell } from "./checkout-upsells.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, notFoundJson } from "./seller-json.ts";

// POST /checkout/discounts, POST /checkout/upsells
function create(policy: typeof checkoutOfferCodePolicy.create, reason: string) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(input, policy, () => {
      throw new HandBackToRails(reason);
    });
}

// `OfferCode.find_by_external_id!(params[:id])`: any seller's code, deleted ones included; the policy compares the owner.
function changeOfferCode(reason: string) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      async (context) => {
        const id = decrypt(input.routeParams.id ?? "");
        const [row] =
          id === null
            ? []
            : await selectRows<{ user_id: bigint }>(
                Prisma.sql`SELECT ${column("offer_codes", "user_id")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${id} LIMIT 1`,
              );
        if (row === undefined) throw new RoutingError("Not Found");
        const denied = await authorizeJson(input, () => authorize(checkoutOfferCodePolicy.update, context, row));
        if (denied) return denied;
        throw new HandBackToRails(reason);
      },
    );
}

// PATCH|PUT /checkout/upsells/:id
function updateUpsell(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (context) => {
      const row = await findUpsell(input, { alive: false });
      const denied = await authorizeJson(input, () => authorize(checkoutUpsellPolicy.update, context, row));
      if (denied) return denied;
      throw new HandBackToRails("SaveUpsellService builds offer codes and rewrites variants and selected products");
    },
  );
}

// `current_seller.sales.find_by_external_id(params[:purchase_id]) || e404_json`, then `authorize [:audience, purchase]`.
function changePurchase(reason: string) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      async () => {
        const id = decrypt(input.routeParams.purchase_id ?? "");
        const [row] =
          id === null
            ? []
            : await selectRows(
                Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${input.context.currentSeller!.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
              );
        // set_purchase halts the chain, so the after_actions (XSRF-TOKEN) do not run.
        if (row === undefined) return { ...notFoundJson(), rescued: true };
        const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.update, context));
        if (denied) return denied;
        throw new HandBackToRails(reason);
      },
    );
}

const DISCOUNT_WRITE =
  "an offer code runs its validations against live product defaults and reindexes through a Redis script";

registerMutations(
  {
    method: "POST",
    pattern: "/checkout/discounts",
    json: true,
    run: create(checkoutOfferCodePolicy.create, DISCOUNT_WRITE),
  },
  { method: "PATCH", pattern: "/checkout/discounts/:id", json: true, run: changeOfferCode(DISCOUNT_WRITE) },
  { method: "PUT", pattern: "/checkout/discounts/:id", json: true, run: changeOfferCode(DISCOUNT_WRITE) },
  {
    method: "DELETE",
    pattern: "/checkout/discounts/:id",
    json: true,
    run: changeOfferCode("deleting an offer code reindexes through a Redis script"),
  },
  {
    method: "POST",
    pattern: "/checkout/upsells",
    json: true,
    run: create(checkoutUpsellPolicy.create, "SaveUpsellService builds offer codes and variants"),
  },
  { method: "PATCH", pattern: "/checkout/upsells/:id", json: true, run: updateUpsell },
  { method: "PUT", pattern: "/checkout/upsells/:id", json: true, run: updateUpsell },
  {
    method: "POST",
    pattern: "/purchases/:purchase_id/pings",
    json: true,
    run: changePurchase("the ping is an outbound webhook"),
  },
  {
    method: "PATCH",
    pattern: "/purchases/:purchase_id/variants/:variant_id",
    json: true,
    run: changePurchase("changing the option rewrites the purchase and its inventory"),
  },
);
