// Checkout::DiscountsController#index (`/checkout/discounts`). Registered in ./pages.ts. The JSON endpoints are in controllers/checkout-discounts.ts.
import type { ActionOptions } from "../controllers/application-controller.ts";
import { signedInFilters } from "../controllers/buyer-pages.ts";
import { listingParams } from "../controllers/checkout-discounts.ts";
import { parseNestedQuery } from "../controllers/rails-body.ts";
import { checkoutOfferCodePolicy } from "../policies/checkout-offer-code.ts";
import { discountsProps, fetchOfferCodes } from "../presenters/discounts.ts";
import type { PageSpec } from "./pages.ts";

// Sellers::BaseController (RequireAccountEmail, authenticate_user!), `authorize [:checkout, OfferCode]`, then the action.
export const DISCOUNTS_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    nestedQuery: true,
    authorize: checkoutOfferCodePolicy.index,
    state: async (chain, context) => ({
      discounts: await discountsProps(context.seller!, context, await fetchOfferCodes(context.seller!, listingParams(parseNestedQuery(chain.request.queryString)))),
    }),
  }),
};

export const CHECKOUT_DISCOUNTS_PAGES: Record<string, PageSpec> = {
  "/checkout/discounts": {
    component: "Checkout/Discounts/Index",
    options: DISCOUNTS_OPTIONS,
    props: (_, { meta, state }) => {
      meta.set({ title: "Discounts" });
      return state.discounts as Record<string, unknown>;
    },
  },
};
