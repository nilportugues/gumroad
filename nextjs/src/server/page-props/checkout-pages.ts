// CheckoutController#show and the subscription management page. Registered in ./pages.ts.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { CHECKOUT_OPTIONS } from "../controllers/checkout-pages.ts";
import { MANAGE_OPTIONS } from "../controllers/subscription-pages.ts";
import { remoteIp } from "./audience/events.ts";
import { cartProps, checkoutProps, emptyCartPaymentProps, type CheckoutCart } from "./checkout/checkout.ts";
import { optional } from "./lazy-props.ts";
import { NotPortedError } from "./not-ported.ts";
import type { PageSpec } from "./pages.ts";
import { sellerFontsCssSource } from "./settings/profile.ts";

export const CHECKOUT_PAGES: Record<string, PageSpec> = {
  // The filter has handed back everything with a product in it, so the cart holds nothing.
  "/checkout": {
    component: "Checkout/Show",
    options: CHECKOUT_OPTIONS,
    analyticsEnabled: true,
    props: async (_, action) => {
      const user = railsLoggedInUser(action.context);
      return {
        cart: cartProps((action.state.cart as CheckoutCart | null) ?? null),
        checkout: await checkoutProps({ user, remoteIp: remoteIp(action.headers), protocol: action.config.protocol, discoverDomain: action.config.discoverDomain }),
        checkout_payment: emptyCartPaymentProps(),
        // The filter hands back a partial reload that asks for it.
        recommended_products: optional(() => {
          throw new NotPortedError("Checkout recommended_products (RecommendedProducts::CheckoutService)");
        }),
        stripe_fonts_css_source: sellerFontsCssSource(),
        checkout_style: null,
      };
    },
  },
  // SubscriptionsController#manage: the access check answers (404, magic link redirect) or hands the request to Rails.
  "/subscriptions/:subscription_id/manage": {
    component: "Subscriptions/Manage",
    options: MANAGE_OPTIONS,
    props: () => {
      throw new NotPortedError("Subscriptions/Manage (CheckoutPresenter#subscription_manager_props)");
    },
  },
};
