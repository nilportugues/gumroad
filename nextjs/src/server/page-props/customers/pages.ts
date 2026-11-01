// CustomersController#index (`/customers`, `/customers/:link_id`). Registered in ../pages.ts. GET renders only: the
// JSON endpoints (`/customers/paged`, `/customers/sales`, charges, emails, missed posts) and every mutation stay in Rails.
import { HandBackToRails, type ActionOptions } from "../../controllers/application-controller.ts";
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { audiencePurchasePolicy } from "../../policies/seller-analytics.ts";
import { createUserEvent } from "../audience/events.ts";
import type { PageSpec } from "../pages.ts";
import { customersProps } from "./customers.ts";

// Rails routes these single-segment JSON endpoints ahead of `/customers/:link_id`.
const JSON_ENDPOINTS = new Set(["paged", "sales"]);

const linkIdOf = (path: string): string | null => {
  const segment = path.replace(/\/+$/u, "").split("/")[2];
  return segment === undefined ? null : decodeURIComponent(segment);
};

// Sellers::BaseController (RequireAccountEmail, authenticate_user!), `before_action :authorize`, then the action.
export const CUSTOMERS_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: audiencePurchasePolicy.index,
    beforeAction: async (chain) => {
      const linkId = linkIdOf(chain.request.path);
      if (linkId !== null && JSON_ENDPOINTS.has(linkId)) throw new HandBackToRails();
      return null;
    },
    state: async (chain, context) => {
      const linkId = linkIdOf(chain.request.path);
      const text = (name: string) => queryParam(chain.request, name) ?? undefined;
      const customersPresenter = await customersProps(context, { linkId, page: text("page"), query: text("query"), boughtFrom: text("bought_from") });
      return { customers_presenter: customersPresenter };
    },
  }),
};

const customersIndex: PageSpec = {
  component: "Customers/Index",
  options: CUSTOMERS_OPTIONS,
  props: async (_, { context, meta, url, headers, renderState, state }) => {
    // CustomersController#set_default_page_title
    meta.set({ title: "Sales" });
    if (!headers.has("x-inertia-partial-component")) await createUserEvent("customers_view", { context, headers, url, state: renderState });
    return { customers_presenter: state.customers_presenter };
  },
};

export const CUSTOMERS_PAGES: Record<string, PageSpec> = {
  "/customers": customersIndex,
  "/customers/:link_id": customersIndex,
};
