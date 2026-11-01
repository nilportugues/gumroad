// BalanceController#index (`/payouts`). Registered in ../pages.ts.
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { balancePolicy } from "../../policies/balance.ts";
import { lazy, merge } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";
import { planPayouts, payoutsProps, type PayoutsPlan } from "./payouts.ts";

// Sellers::BaseController (RequireAccountEmail, authenticate_user!), then the action's `authorize :balance`.
// The plan is built here because what it cannot answer (daily payouts, instant payout eligibility, a cached
// blob) goes to Rails whole, and only a filter can do that.
const PAYOUTS_OPTIONS = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: balancePolicy.index,
    state: async (chain, context) => ({ plan: await planPayouts(context.seller!, queryParam(chain.request, "page") ?? null) }),
  }),
};

export const PAYOUTS_PAGES: Record<string, PageSpec> = {
  "/payouts": {
    component: "Payouts/Index",
    options: PAYOUTS_OPTIONS,
    props: (_, action) => {
      action.meta.set({ title: "Payouts" });
      const props = payoutsProps(action.state.plan as PayoutsPlan);
      let rest: ReturnType<typeof props.rest> | undefined;
      const shared = () => (rest ??= props.rest());
      const pick = (key: string) => async () => (await shared())[key];
      return {
        next_payout_period_data: lazy(props.next),
        processing_payout_periods_data: lazy(props.processing),
        payouts_status: lazy(pick("payouts_status")),
        payouts_paused_by: lazy(pick("payouts_paused_by")),
        payout_reserve_percent: lazy(pick("payout_reserve_percent")),
        instant_payout: lazy(pick("instant_payout")),
        show_instant_payouts_notice: lazy(pick("show_instant_payouts_notice")),
        tax_center_enabled: lazy(pick("tax_center_enabled")),
        past_payout_period_data: merge(props.past),
        pagination: lazy(pick("pagination")),
        scheduled_payout: lazy(pick("scheduled_payout")),
      };
    },
  },
};
