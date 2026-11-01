// The subscription management page. Registered in ./pages.ts.
import { MANAGE_OPTIONS } from "../controllers/subscription-pages.ts";
import { NotPortedError } from "./not-ported.ts";
import type { PageSpec } from "./pages.ts";

export const CHECKOUT_PAGES: Record<string, PageSpec> = {
  // SubscriptionsController#manage: the access check answers (404, magic link redirect) or hands the request to Rails.
  "/subscriptions/:subscription_id/manage": {
    component: "Subscriptions/Manage",
    options: MANAGE_OPTIONS,
    props: () => {
      throw new NotPortedError("Subscriptions/Manage (CheckoutPresenter#subscription_manager_props)");
    },
  },
};
