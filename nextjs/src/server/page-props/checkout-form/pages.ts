// Checkout::FormController#show (props in ./form.ts); #update is in controllers/checkout-form-mutations.ts.
import { authorize } from "../../policies/authorize.ts";
import { checkoutFormPolicy } from "../../policies/checkout-form.ts";
import { loadSellerContext } from "../../policies/seller-context.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import type { PageSpec } from "../pages.ts";

import { assertFormSupported, formProps } from "./form.ts";

export const CHECKOUT_FORM_PAGES: Record<string, PageSpec> = {
  "/checkout/form": {
    component: "Checkout/Form/Show",
    guard: (info) =>
      sellerGuard(info, (context) => authorize(checkoutFormPolicy.show, context), {
        afterAuthorize: (context) => assertFormSupported(context.seller!),
      }),
    props: async (_, { context, meta }) => {
      meta.set({ title: "Checkout form" });
      return formProps(context.currentSeller!, await loadSellerContext(context));
    },
  },
};
