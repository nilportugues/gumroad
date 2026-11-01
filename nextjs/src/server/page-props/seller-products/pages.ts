// The seller's product pages: Products/Index, Products/Archived/Index, Products/Affiliated/Index,
// Products/Collabs/Index, Products/New and Products/Edit. The controllers' filters are in
// controllers/seller-products-pages.ts; GET renders only.
import type { User } from "@prisma/client";

import { PRODUCTS_AFFILIATED_OPTIONS, PRODUCTS_ARCHIVED_OPTIONS, PRODUCTS_COLLABS_OPTIONS, PRODUCTS_INDEX_OPTIONS, PRODUCTS_NEW_OPTIONS } from "../../controllers/seller-products-pages.ts";
import { piracyReportsTabVisible } from "../../policies/link.ts";
import { loadSellerContext } from "../../policies/seller-context.ts";
import { defer, lazy } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";
import { affiliatedParams, affiliatedProductsProps, assertAffiliatedSupported, canRemoveAffiliations } from "./affiliated.ts";
import { archivedProductsCount, hasProducts, tableData } from "./dashboard-products.ts";
import { COLLAB_SORT_KEYS, assertCollabsSupported, collabsFlags, collabsStats, collabsTableData } from "./collabs.ts";
import { listingParams } from "./listing.ts";
import { newPageProps } from "./new-page.ts";
import { linkPolicy } from "../../policies/link.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") });
const queryOfChain = (chain: { request: { queryString: string } }) => ({ queryString: chain.request.queryString });

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

const productsAffiliated: PageSpec = {
  component: "Products/Affiliated/Index",
  options: PRODUCTS_AFFILIATED_OPTIONS((seller, chain) => assertAffiliatedSupported(seller, chain.request.queryString)),
  props: async (_, { context, meta, url }) => {
    meta.set({ title: "Products" });
    const sellerContext = await loadSellerContext(context);
    return affiliatedProductsProps(seller(context), sellerContext, affiliatedParams(url.search.replace(/^\?/, "")), canRemoveAffiliations(sellerContext));
  },
};

const productsCollabs: PageSpec = {
  component: "Products/Collabs/Index",
  options: PRODUCTS_COLLABS_OPTIONS((seller, chain) => assertCollabsSupported(seller, listingParams(queryOfChain(chain), COLLAB_SORT_KEYS))),
  props: (_, { context, meta, url }) => {
    meta.set({ title: "Products" });
    const params = listingParams(queryOf(url), COLLAB_SORT_KEYS);
    const sellerContext = () => loadSellerContext(context);
    const flags = async () => collabsFlags(seller(context), await sellerContext());
    return {
      stats: lazy(() => collabsStats(seller(context), params)),
      archived_tab_visible: lazy(async () => (await flags()).archived_tab_visible),
      piracy_reports_tab_visible: lazy(async () => (await flags()).piracy_reports_tab_visible),
      collaborators_disabled_reason: lazy(async () => (await flags()).collaborators_disabled_reason),
      products_data: lazy(async () => collabsTableData(seller(context), await sellerContext(), params, "products")),
      memberships_data: lazy(async () => collabsTableData(seller(context), await sellerContext(), params, "memberships")),
    };
  },
};

const productsNew: PageSpec = {
  component: "Products/New",
  mobileAppWebView: true,
  options: PRODUCTS_NEW_OPTIONS,
  props: async (_, { context, meta }) => {
    meta.set({ title: "What are you creating?" });
    return newPageProps(seller(context));
  },
};

export const SELLER_PRODUCTS_PAGES: Record<string, PageSpec> = {
  "/products/collabs": productsCollabs,
  "/products/new": productsNew,
  "/products": productsIndex,
  "/products/archived": productsArchived,
  "/products/affiliated": productsAffiliated,
};
