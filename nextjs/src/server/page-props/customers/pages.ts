// CustomersController#index (`/customers`, `/customers/:link_id`). Registered in ../pages.ts. GET renders only: the
// JSON endpoints (`/customers/paged`, `/customers/sales`, charges, emails, missed posts) and every mutation stay in Rails.
import { HandBackToRails, type ActionOptions } from "../../controllers/application-controller.ts";
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { receiptUrlOptions } from "../../controllers/customer-details.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { canPingSales } from "../../models/ping-notification.ts";
import { UserFlags } from "../../models/user.ts";
import { installmentPolicy } from "../../policies/installment.ts";
import { audiencePurchasePolicy } from "../../policies/seller-analytics.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { createUserEvent } from "../audience/events.ts";
import { defer } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";

import {
  buildCharges,
  buildCustomerEmails,
  bundleProductPurchaseIds,
  findSellerSale,
  missedPosts,
} from "./customer-details.ts";
import { countryNames, customersOfPurchases, customersProps, hasCustomerAudience } from "./customers.ts";

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
      const customersPresenter = await customersProps(context, {
        linkId,
        page: text("page"),
        query: text("query"),
        boughtFrom: text("bought_from"),
      });
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
    if (!headers.has("x-inertia-partial-component"))
      await createUserEvent("customers_view", { context, headers, url, state: renderState });
    return { customers_presenter: state.customers_presenter };
  },
};

const saleIdOf = (path: string) => decodeURIComponent(path.replace(/\/+$/u, "").split("/")[3] ?? "");

// CustomersController#show (`/customers/sale/:purchase_id`): the same filters, then the sale of the current seller (a 404 otherwise).
export const CUSTOMER_SALE_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: audiencePurchasePolicy.index,
    state: async (chain, context) => {
      const seller = context.seller!;
      const sale = await findSellerSale(seller.id, saleIdOf(chain.request.path));
      const [customer] = await customersOfPurchases(context, [String(sale.id)]);
      return {
        customer,
        can_ping: await canPingSales(seller),
        can_email: (await hasCustomerAudience(seller.id)) && installmentPolicy.create(context),
        show_refund_fee_notice: !UserFlags.isSet(seller.flags, "refund_fee_notice_shown"),
        emails: await buildCustomerEmails(seller, sale, receiptUrlOptions(chain.request)),
        missed_posts: await missedPosts(sale),
        charges: await buildCharges(sale),
        product_purchases: PurchaseFlags.isSet(sale.flags, "is_bundle_purchase")
          ? await customersOfPurchases(context, await bundleProductPurchaseIds(sale))
          : [],
      };
    },
  }),
};

const customerSale: PageSpec = {
  component: "Customers/Show",
  options: CUSTOMER_SALE_OPTIONS,
  props: (_, { meta, state }) => {
    // CustomersController#set_default_page_title
    meta.set({ title: "Sales" });
    return {
      customer: state.customer,
      countries: countryNames(),
      can_ping: state.can_ping,
      can_email: state.can_email,
      show_refund_fee_notice: state.show_refund_fee_notice,
      emails: state.emails,
      missed_posts: defer(() => state.missed_posts),
      charges: state.charges,
      product_purchases: state.product_purchases,
    };
  },
};

export const CUSTOMERS_PAGES: Record<string, PageSpec> = {
  "/customers": customersIndex,
  "/customers/:link_id": customersIndex,
  "/customers/sale/:purchase_id": customerSale,
};
