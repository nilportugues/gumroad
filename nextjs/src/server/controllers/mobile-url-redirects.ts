// Api::Mobile::UrlRedirectsController#fetch_placeholder_products. Only the mobile token is checked (no OAuth scope), and the answer is
// always an empty list.
import { registerMobile, renderJson, type MobileAction } from "./mobile-api.ts";

export const FETCH_PLACEHOLDER_PRODUCTS: MobileAction = {
  method: "GET",
  pattern: "/mobile/url_redirects/fetch_placeholder_products",
  scopes: null,
  run: async () => renderJson({ success: true, placeholder_products: [] }),
};

registerMobile(FETCH_PLACEHOLDER_PRODUCTS);
