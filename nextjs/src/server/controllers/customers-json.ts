// CustomersController#paged (`GET /customers/paged`): the JSON the customers table fetches for the next page, a search or a new
// sort, with the filters of the filter box (customers-filters.ts).
import { customersProps, rubyToI } from "../page-props/customers/customers.ts";
import { audiencePurchasePolicy } from "../policies/seller-analytics.ts";

import { type ActionContext, type ActionOptions, HandBackToRails, processAction } from "./application-controller.ts";
import { customersSalesFilters, FILTER_PARAMS, readFilterParams } from "./customers-filters.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { parseNestedQuery } from "./rails-body.ts";

// Text fields are not sortable in ES; product_name sorts on its keyword subfield.
const SORT_KEY_TO_SEARCH_FIELD: Record<string, string> = {
  created_at: "created_at",
  price_cents: "price_cents",
  product_name: "product_name.raw",
};
const SERVED_PARAMS = new Set(["page", "query", "sort", "bought_from", ...FILTER_PARAMS]);

export const CUSTOMERS_PAGED_OPTIONS: ActionOptions = {};

async function paged(action: ActionContext) {
  return sellerJsonAction(
    action,
    audiencePurchasePolicy.index,
    async (sellerContext) => {
      const params = parseNestedQuery(action.request.queryString);
      if (Object.keys(params).some((key) => !SERVED_PARAMS.has(key)))
        throw new HandBackToRails("a parameter the port does not read");
      for (const key of ["page", "query", "bought_from"])
        if (key in params && typeof params[key] !== "string") throw new HandBackToRails(`a non-scalar ${key}`);
      const sortParam = params.sort;
      if (sortParam !== undefined && (sortParam === null || typeof sortParam !== "object" || Array.isArray(sortParam)))
        throw new HandBackToRails("a sort that is not a hash");
      const { key, direction } = (sortParam ?? {}) as Record<string, unknown>;
      if ((key !== undefined && typeof key !== "string") || (direction !== undefined && typeof direction !== "string"))
        throw new HandBackToRails("a non-scalar sort");
      const field = typeof key === "string" ? SORT_KEY_TO_SEARCH_FIELD[key] : undefined;
      // `params[:page] = params[:page].to_i - 1`
      const page = String(rubyToI(params.page as string | undefined) - 1);
      const filters = readFilterParams(params);
      const props = await customersProps(sellerContext, {
        linkId: null,
        page,
        query: params.query as string | undefined,
        // `Compliance::Countries.historical_names(country || params[:bought_from])`
        boughtFrom: filters.country ?? (params.bought_from as string | undefined),
        filters: await customersSalesFilters(sellerContext.seller!, filters),
        sort: field ? { [field]: { order: direction === "asc" ? "asc" : "desc" } } : null,
        paged: true,
      });
      return jsonResponse(props, 200, true);
    },
    { paramsRead: true },
  );
}

export const customersPagedResponse = (incoming: Request): Promise<Response> =>
  processAction(incoming, CUSTOMERS_PAGED_OPTIONS, paged);
