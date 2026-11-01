// DashboardController#index (`/dashboard`). Registered in ../pages.ts.
//
// The action's order is kept: check_payment_details, `authorize :dashboard`, session.delete(:social_connect_return), the
// redirect of a seller suspended for a terms violation, LargeSeller.create_if_warranted (a large seller goes to Rails),
// the presenter, then SocialConnectFunnel.record_offers!, which writes Event rows on this GET.
import { type ActionOptions } from "../../controllers/application-controller.ts";
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { recordOffers } from "../../models/social-connect-funnel.ts";
import { dashboardPolicy } from "../../policies/dashboard.ts";
import { checkPaymentDetails } from "../audience/payment-requirements.ts";
import type { PageSpec } from "../pages.ts";
import { creatorHomeProps } from "./creator-home.ts";

const SESSION_KEY = "social_connect_return";

export const DASHBOARD_HOME_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: dashboardPolicy.index,
    beforeAction: async (_chain, context) => {
      await checkPaymentDetails(context);
      return null;
    },
    action: async (chain, context) => {
      delete chain.session.data[SESSION_KEY];
      if (context.seller!.user_risk_state === "suspended_for_tos_violation") {
        return { status: 302, location: `${chain.request.protocol}${chain.request.hostWithPort}/products` };
      }
      return null;
    },
    state: async (chain, context) => {
      const creatorHome = await creatorHomeProps(context, chain.now);
      await recordOffers({
        userId: context.seller!.id,
        connections: creatorHome.social_connections,
        surface: "getting_started",
        skip: chain.auth.context.impersonatedUser !== null,
        now: () => chain.now,
      });
      return { creator_home: creatorHome };
    },
  }),
};

export const DASHBOARD_HOME_PAGES: Record<string, PageSpec> = {
  "/dashboard": {
    component: "Dashboard/Index",
    options: DASHBOARD_HOME_OPTIONS,
    props: (_, action) => ({ creator_home: action.state.creator_home }),
  },
};
