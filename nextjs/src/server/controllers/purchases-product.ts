// Purchases::ProductController#show (app/controllers/purchases/product_controller.rb): the product page as it stood when the purchase
// was made, which sellers open to answer a chargeback.
//
// Only `set_purchase` is served (404 for an unknown purchase). The props are PurchaseProductPresenter's, which rebuilds the product from
// its PaperTrail version at the purchase's `created_at`; that reify and the product page's presenter are Rails', so a found purchase
// goes to Rails whole.
import { HandBackToRails } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { setPurchase } from "./purchase-access-writes.ts";
import { requestFormat } from "./rails-params.ts";

export async function show(input: MutationInput): Promise<never> {
  if (requestFormat(input.request) !== "html") throw new HandBackToRails("a request whose format is not HTML");
  await setPurchase(input.routeParams.purchase_id!);
  throw new HandBackToRails("the product page of a purchase, which rebuilds the product from its version");
}

registerMutations({
  method: "GET",
  pattern: "/purchases/:purchase_id/product",
  skipForgeryProtection: true,
  run: show,
});
