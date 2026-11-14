// Products::MarketingAbandonedCartsController (app/controllers/products/marketing_abandoned_carts_controller.rb): the Share tab's
// cart recovery toggle.
//
// Ported: the 404 of an unknown product, the policy, and the 404 of a seller without the marketing tools, of another seller's product
// and of one that is not published. Handed to Rails before any write: whatever passes those guards. #show renders the email preview
// (inline product cards with their images) and #update pauses or publishes a workflow and may create one under a product row lock.
import { marketingEnabledFor } from "../models/marketing-action.ts";
import { authorize } from "../policies/authorize.ts";
import { marketingActionPolicy } from "../policies/marketing-action.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { fetchProduct, notFound } from "./marketing-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson } from "./seller-json.ts";

function guarded(reason: string) {
  return (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      async (sellerContext) => {
        const product = await fetchProduct(input);
        const denied = await authorizeJson(input, () => authorize(marketingActionPolicy.index, sellerContext));
        if (denied) return denied;
        const seller = input.context.currentSeller!;
        // Link#published?
        const published = product.deleted_at === null && product.purchase_disabled_at === null && !product.draft;
        if (!(await marketingEnabledFor(seller)) || product.user_id !== seller.id || !published) return notFound();
        throw new HandBackToRails(reason);
      },
    );
}

registerMutations(
  {
    method: "GET",
    pattern: "/products/:product_id/marketing_abandoned_cart.json",
    skipForgeryProtection: true,
    run: guarded("the cart recovery state renders the email preview"),
  },
  {
    method: "PUT",
    pattern: "/products/:product_id/marketing_abandoned_cart.json",
    json: true,
    run: guarded("toggling cart recovery publishes or pauses a workflow"),
  },
  {
    method: "PATCH",
    pattern: "/products/:product_id/marketing_abandoned_cart.json",
    json: true,
    run: guarded("toggling cart recovery publishes or pauses a workflow"),
  },
);
