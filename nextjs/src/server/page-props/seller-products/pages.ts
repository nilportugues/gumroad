// The seller's product pages: Products/Index, Products/Archived/Index, Products/Affiliated/Index,
// Products/Collabs/Index, Products/New and Products/Edit. The controllers' filters are in
// controllers/seller-products-pages.ts; GET renders only.
import type { User } from "@prisma/client";

import { PRODUCTS_ARCHIVED_OPTIONS, PRODUCTS_INDEX_OPTIONS } from "../../controllers/seller-products-pages.ts";
import { piracyReportsTabVisible } from "../../policies/link.ts";
import { loadSellerContext } from "../../policies/seller-context.ts";
import { defer, lazy } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";
import { archivedProductsCount, hasProducts, tableData } from "./dashboard-products.ts";
import { listingParams } from "./listing.ts";
import { linkPolicy } from "../../policies/link.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") });

function dashboardProps(archived: boolean): PageSpec["props"] {
  return (_, { context, url }) => {
    const params = listingParams(queryOf(url));
    const sellerContext = () => loadSellerContext(context);
    const props: Record<string, unknown> = {
      query: params.query,
      has_products: lazy(() => hasProducts(seller(context), archived)),
      can_create_product: lazy(async () => linkPolicy.create(await sellerContext())),
      piracy_reports_tab_visible: lazy(async () => piracyReportsTabVisible(await sellerContext())),
      products_data: defer(async () => tableData(seller(context), await sellerContext(), "products", archived, params), "data"),
      memberships_data: defer(async () => tableData(seller(context), await sellerContext(), "memberships", archived, params), "data"),
    };
    if (!archived) props.archived_products_count = lazy(() => archivedProductsCount(seller(context)));
    return props;
  };
}

const productsIndex: PageSpec = {
  component: "Products/Index",
  // LinksController's `enable_mobile_app_web_view` shares the flag with every action of the controller.
  mobileAppWebView: true,
  options: PRODUCTS_INDEX_OPTIONS,
  props: (params, action) => {
    action.meta.set({ title: "Products" });
    return dashboardProps(false)(params, action);
  },
};

const productsArchived: PageSpec = {
  component: "Products/Archived/Index",
  options: PRODUCTS_ARCHIVED_OPTIONS,
  props: (params, action) => {
    action.meta.set({ title: "Archived products" });
    return dashboardProps(true)(params, action);
  },
};

export const SELLER_PRODUCTS_PAGES: Record<string, PageSpec> = {
  "/products": productsIndex,
  "/products/archived": productsArchived,
};
