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
import { linkPolicy, collaboratingProductIds } from "../../policies/link.ts";
import * as Routes from "@/lib/navigation/routes";
import { HandBackToRails, type Redirected, RoutingError } from "../../controllers/application-controller.ts";
import { NotAuthorizedError } from "../../policies/seller-context.ts";
import { authorize } from "../../policies/authorize.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { Prisma } from "@prisma/client";
import { findLink, findUserById, type LinkRow } from "../../presenters/product-reads.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import { assertEditSupported, editProps } from "./edit.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/u, "") });
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
    return affiliatedProductsProps(seller(context), sellerContext, affiliatedParams(url.search.replace(/^\?/u, "")), canRemoveAffiliations(sellerContext));
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

// LinksController#edit: `fetch_product_by_unique_permalink`, `authorize @product`, then a bundle goes to its own editor.
async function editProduct(permalink: string): Promise<LinkRow> {
  const [found] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`);
  const product = found ? await findLink(found.id) : null;
  if (!product) throw new RoutingError("Not Found");
  return product;
}

// enable_mobile_app_web_view signs the app's WebView in with an OAuth token and persists the flag in the session.
const assertNotMobileAppWebView = (url: URL) => {
  if ((url.searchParams.get("access_token") ?? "") !== "" || url.searchParams.get("display") === "mobile_app") throw new HandBackToRails();
};

const productsEdit: PageSpec = {
  component: "Products/Edit",
  mobileAppWebView: true,
  guard: async (info) => {
    assertNotMobileAppWebView(info.url);
    let bundleRedirect: string | null = null;
    let denied: Redirected | null = null;
    const redirected = await sellerGuard(info, async (context) => {
      const product = await editProduct(info.params.id!);
      const collaborating = await collaboratingProductIds(context, [product.id]);
      try {
        authorize((c, record) => linkPolicy.edit(c, record, collaborating), context, { id: product.id, user_id: product.user_id, flags: product.flags ?? 0 });
      } catch (error) {
        if (!(error instanceof NotAuthorizedError)) throw error;
        // PunditAuthorization#product_edit_user_not_authorized: a shared edit link lands on the product page.
        denied = { status: 302, location: Routes.short_link_url(product.unique_permalink!, info.urlOptions), rescued: true };
        return;
      }
      if (LinkFlags.isSet(product.flags as bigint, "is_bundle")) {
        bundleRedirect = `/bundles/${externalId(product.id)}/product/edit`;
        return;
      }
      const owner = (await findUserById(product.user_id!))!;
      await assertEditSupported(product, owner, context.seller!.id);
    });
    if (redirected) return redirected;
    if (denied) return denied;
    return bundleRedirect ? { status: 302, location: bundleRedirect } : null;
  },
  props: async (params, { context, meta, url }) => {
    const product = await editProduct(params.id!);
    meta.set({ title: product.name ?? "" });
    const owner = (await findUserById(product.user_id!))!;
    return editProps({ product, seller: owner, sellerExternalId: seller(context).external_id!, aiGenerated: url.searchParams.get("ai_generated") === "true" });
  },
};

export const SELLER_PRODUCTS_PAGES: Record<string, PageSpec> = {
  "/products/:id/edit": productsEdit,
  "/products/:id/edit/*other": productsEdit,
  "/products/collabs": productsCollabs,
  "/products/new": productsNew,
  "/products": productsIndex,
  // `resources :links` names the same `links#index`.
  "/links": productsIndex,
  "/products/archived": productsArchived,
  "/products/affiliated": productsAffiliated,
};
