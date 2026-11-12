// LinksController#show (Products/Show), on the Gumroad domain (always a redirect to the seller's host), on
// seller subdomains and custom domains, and on a product's own domain. The filters live in
// controllers/product-page.ts; the render is presenters/product-page.ts, which hands back to Rails what it
// cannot prove (HandBackToRails in the filter chain).
import { railsLoggedInUser } from "../auth/resolve.ts";
import { PRODUCT_PAGE_OPTIONS } from "../controllers/product-page.ts";
import { parseQuery } from "../controllers/rails-query.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import {
  buildProductPage,
  guidOf,
  PRODUCT_PAGE_COMPONENTS,
  productPageKind,
  sellerCustomDomainUrl,
  setProductPageMeta,
  viewerOf,
} from "../presenters/product-page.ts";
import { findLink, findUserById } from "../presenters/product-reads.ts";

import { remoteIp } from "./audience/events.ts";
import { aliveCartProductCount } from "./checkout/checkout.ts";
import { autocompleteResults, isAutocompleteOnlyRequest } from "./discover/discover.ts";
import type { PageSpec } from "./pages.ts";

// LinksController#show: `layout`, `embed` and `overlay` pick the Inertia component.
const productPage: PageSpec = {
  component: (action) =>
    PRODUCT_PAGE_COMPONENTS[
      productPageKind(parseQuery(action.url.search.replace(/^\?/u, "")), action.state.storefront_wrapped === "1")
    ],
  mobileAppWebView: true,
  buyerCurrencyFooter: true,
  options: PRODUCT_PAGE_OPTIONS,
  props: async (params, action) => {
    const row = (await findLink(BigInt(String(action.state.product_id))))!;
    const seller = (await findUserById(row.user_id!))!;
    const query = parseQuery(action.url.search.replace(/^\?/u, ""));
    const pathCode = params.code;
    const queryCode = typeof query.code === "string" && query.code.trim() !== "" ? query.code : null;
    const code = pathCode && pathCode.trim() !== "" ? pathCode : queryCode;
    const kind = productPageKind(query, action.state.storefront_wrapped === "1");
    // The discover layout's search box asks for its suggestions alone; Rails answers before it builds the product.
    if (kind === "discover" && isAutocompleteOnlyRequest(action.headers)) {
      await setProductPageMeta(
        action.meta,
        row,
        seller,
        action.url.hostname,
        sellerCustomDomainUrl(action.state.user_custom_domain === "1", action.url.host),
      );
      const user = railsLoggedInUser(action.context);
      const guid = guidOf(action.headers.get("cookie"));
      return {
        autocomplete_results: await autocompleteResults({ query: query.query as never }, user, guid),
      };
    }
    const afterRender: (() => Promise<void>)[] = [];
    const viewer = viewerOf(
      query,
      code,
      railsLoggedInUser(action.context),
      railsLoggedInUser(action.context) ? await loadSellerContext(action.context) : null,
      remoteIp(action.headers),
      guidOf(action.headers.get("cookie")),
      sellerCustomDomainUrl(action.state.user_custom_domain === "1", action.url.host),
      {
        host: action.url.hostname,
        hostWithPort: action.url.host,
        protocol: action.url.protocol === "https:" ? "https://" : "http://",
      },
    );
    const page = await buildProductPage(
      row,
      seller,
      { ...viewer, afterRender, queryString: action.url.search.replace(/^\?/u, "") },
      action.meta,
      action.url.hostname,
      kind,
    );
    for (const effect of afterRender) await effect();
    return page;
  },
};

// LinksController#cart_items_count for a request that is not asking for JSON. `disable_third_party_analytics!` is prepended to it.
const cartItemsCountPage: PageSpec = {
  component: "Products/CartItemsCount",
  analyticsEnabled: false,
  // LinksController shares is_mobile_app_web_view with every action; only new, create and edit sign the WebView in.
  mobileAppWebView: true,
  props: async (_, action) => {
    const user = railsLoggedInUser(action.context);
    return { cart_items_count: await aliveCartProductCount(user?.id ?? null, guidOf(action.headers.get("cookie"))) };
  },
};

export const PRODUCT_PAGES: Record<string, PageSpec> = {
  "/cart_items_count": cartItemsCountPage,
  "/l/:id": productPage,
  "/l/:id/:code": productPage,
  "seller:/l/:id": productPage,
  "seller:/l/:id/:code": productPage,
  "product:/": productPage,
  "product:/l/:id": productPage,
  "product:/l/:id/:code": productPage,
};
