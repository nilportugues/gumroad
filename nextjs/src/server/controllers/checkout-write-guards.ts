// The guards of the writes behind the checkout dashboard and the Customers page: Checkout::DiscountsController#create, #update and
// #destroy, Checkout::UpsellsController#create and #update, Purchases::PingsController#create and Purchases::VariantsController#update.
//
// Ported: the 404 of an unknown record and the Pundit refusals (answered as JSON), and the creation, update and deletion of a plain
// offer code. Handed to Rails whole, before any write: whatever else passes the guards. The writes run SaveUpsellService validations and
// callbacks, send the ping webhook, move a purchase to another option, or save a code outside the plain shape.
import { Prisma, type OfferCode } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { assertPlainCode, loadOfferCode, OfferCodes } from "../models/offer-code-writes.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { checkoutOfferCodePolicy } from "../policies/checkout-offer-code.ts";
import { checkoutUpsellPolicy } from "../policies/checkout-upsell.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { createDiscount, updateDiscount } from "./checkout-discounts-write.ts";
import { findUpsell } from "./checkout-upsells.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

// POST /checkout/discounts, POST /checkout/upsells
function create(policy: typeof checkoutOfferCodePolicy.create, reason: string, write?: typeof createDiscount) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(input, policy, (context) => {
      if (write) return write(input, context);
      throw new HandBackToRails(reason);
    });
}

// `OfferCode.find_by_external_id!(params[:id])`: any seller's code, deleted ones included; the policy compares the owner.
function changeOfferCode(
  reason: string,
  write?: (input: MutationInput, row: OfferCode, context: SellerContext) => Promise<ActionResult>,
) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      async (context) => {
        const id = decrypt(input.routeParams.id ?? "");
        const [found] =
          id === null
            ? []
            : await selectRows<OfferCode>(
                Prisma.sql`SELECT ${table("offer_codes")}.* FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${id} LIMIT 1`,
              );
        if (found === undefined) throw new RoutingError("Not Found");
        const row = castRow<OfferCode>("OfferCode", found);
        const denied = await authorizeJson(input, () => authorize(checkoutOfferCodePolicy.update, context, row));
        if (denied) return denied;
        if (write) return write(input, row, context);
        throw new HandBackToRails(reason);
      },
    );
}

const DELETED_AT_PRECISION_MS = 1000;

// DiscountsController#destroy: `mark_deleted` saves deleted_at through the validations and callbacks of models/offer-code-writes.ts.
// A code outside the shape that file covers is handed back before the first statement.
async function destroyOfferCode(input: MutationInput, row: OfferCode): Promise<ActionResult> {
  await assertPlainCode(row);
  const record = loadOfferCode(row);
  const now = new Date();
  const deletedAt = new Date(Math.floor(now.getTime() / DELETED_AT_PRECISION_MS) * DELETED_AT_PRECISION_MS);
  if (await OfferCodes.update(record, { deleted_at: deletedAt }, { now: () => now })) return json({ success: true });
  return json({ success: false, error_message: record.errors.fullMessages()[0] }, UNPROCESSABLE_ENTITY);
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

registerMutations(
  {
    method: "POST",
    pattern: "/checkout/discounts",
    json: true,
    run: create(checkoutOfferCodePolicy.create, "", createDiscount),
  },
  { method: "PATCH", pattern: "/checkout/discounts/:id", json: true, run: changeOfferCode("", updateDiscount) },
  { method: "PUT", pattern: "/checkout/discounts/:id", json: true, run: changeOfferCode("", updateDiscount) },
  {
    method: "DELETE",
    pattern: "/checkout/discounts/:id",
    json: true,
    run: changeOfferCode("", destroyOfferCode),
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
