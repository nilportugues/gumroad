import { test as base, expect } from "@playwright/test";

import { isSafeHost } from "./base-url";
import { stripeTestKeysConfigured } from "./env";

const isStripeHost = (hostname: string) => hostname === "stripe.com" || hostname.endsWith(".stripe.com");

export { expect };

/**
 * Every request leaves through here: anything that is not the local app (stripe.js, analytics, recaptcha, fonts)
 * is aborted, so no spec can reach a live third party. Checkout still works for free products without Stripe.js.
 */
export const blockExternalRequests = async (context: import("@playwright/test").BrowserContext) => {
  await context.route(
    // Stripe.js is let through only for the @stripe specs, which require pk_test_/sk_test_ keys.
    (url) =>
      /^https?:$/.test(url.protocol) &&
      !isSafeHost(url.hostname) &&
      !(stripeTestKeysConfigured() && isStripeHost(url.hostname)),
    (route) => route.abort(),
  );
};

export const test = base.extend({
  context: async ({ context }, use) => {
    await blockExternalRequests(context);
    await use(context);
  },
});
