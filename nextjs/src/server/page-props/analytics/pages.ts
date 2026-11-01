// The seller dashboards backed by Elasticsearch: audience, churn, sales analytics, customers and the
// dashboard home. Each is the GET render of a Sellers::BaseController action. Merged into PAGES by pages.ts.
import type { User } from "@prisma/client";

import { setCookieHeader } from "../../controllers/rack-cookies.ts";
import { authorize } from "../../policies/authorize.ts";
import { analyticsPolicy, audiencePolicy, churnPolicy } from "../../policies/seller-analytics.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import { checkPaymentDetails } from "../audience/payment-requirements.ts";
import { always, defer } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";
import { audienceData, audienceRange, totalFollowerCount } from "./audience.ts";
import { churnData, churnParams } from "./churn.ts";
import { createLargeSellerIfWarranted } from "../../models/large-seller.ts";
import { analyticsPageProps } from "./sales.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") });

// DashboardPreference#set_dashboard_preference_to_audience / _to_sales: `cookies[:last_viewed_dashboard] = ...`
const dashboardPreference = (value: "audience" | "sales") => setCookieHeader("last_viewed_dashboard", { value, path: "/", sameSite: "lax" });

const audienceIndex: PageSpec = {
  component: "Audience/Index",
  options: { afterCookies: [dashboardPreference("audience")] },
  guard: (info) =>
    sellerGuard(info, (context) => authorize(audiencePolicy.index, context), {
      // `set_time_range` runs before `check_payment_details`: a range Ruby would read differently is Rails' to answer.
      beforeAuthorize: async (context) => {
        audienceRange(queryOf(info.url));
        await checkPaymentDetails(context);
      },
    }),
  props: async (_, { context, meta, url }) => {
    // AudienceController#set_default_page_title
    meta.set({ title: "Analytics" });
    const range = audienceRange(queryOf(url));
    const total = await totalFollowerCount(seller(context));
    return {
      total_follower_count: always(() => total),
      audience_data: defer(() => audienceData(seller(context), range)),
    };
  },
};

// ChurnController#show: check_payment_details, `authorize :churn`, then LargeSeller.create_if_warranted.
const churnShow: PageSpec = {
  component: "Churn/Show",
  guard: (info) =>
    sellerGuard(info, (context) => authorize(churnPolicy.show, context), {
      beforeAuthorize: async (context) => {
        await checkPaymentDetails(context);
      },
      afterAuthorize: async (context) => {
        // A date Ruby may read differently, or a seller whose ranges Rails caches, is Rails' to answer.
        churnParams(queryOf(info.url));
        await createLargeSellerIfWarranted(context.seller!.id);
      },
    }),
  props: async (_, { context, url }) => ({ churn: await churnData(seller(context), churnParams(queryOf(url))) }),
};

// AnalyticsController#index: check_payment_details, `authorize :analytics`, the presenter, then
// LargeSeller.create_if_warranted. The preference cookie is an after_action.
const analyticsIndex: PageSpec = {
  component: "Analytics/Index",
  options: { afterCookies: [dashboardPreference("sales")] },
  guard: (info) =>
    sellerGuard(info, (context) => authorize(analyticsPolicy.index, context), {
      beforeAuthorize: async (context) => {
        await checkPaymentDetails(context);
      },
      afterAuthorize: async (context) => {
        await createLargeSellerIfWarranted(context.seller!.id);
      },
    }),
  props: async (_, { context, meta }) => {
    // AnalyticsController#set_default_page_title
    meta.set({ title: "Analytics" });
    return { analytics_props: await analyticsPageProps(seller(context)) };
  },
};

export const ANALYTICS_PAGES: Record<string, PageSpec> = {
  "/dashboard/audience": audienceIndex,
  "/dashboard/churn": churnShow,
  "/dashboard/sales": analyticsIndex,
};
