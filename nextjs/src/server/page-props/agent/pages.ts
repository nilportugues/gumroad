// AgentController#index (AgentPresenter#index_props): the Agent dashboard tab.
import { railsEnv } from "../../infra/rails-env.ts";
import { authorize } from "../../policies/authorize.ts";
import { userPolicy } from "../../policies/user.ts";
import { MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT } from "../../search/purchase-sales.ts";
import type { PageSpec } from "../pages.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import { eligibleForStoreAgent } from "../signed-in/policy-props.ts";

const GREETING = "Hi! Ask about your store, or tell me a change to make — I'll always check with you first.";
const SUGGESTIONS = ["How are my sales doing?", "List my products", "Create a 20% off code called LAUNCH"];
const LOCKED_HEADING = "Agent unlocks after your first payout";
// MoneyFormatter.format(MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT, :usd, no_cents_if_whole: true, symbol: true)
const MIN_SALES_FORMATTED = `$${MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT / 100}`;
const LOCKED_EXPLANATION = `The Agent can read your store and make changes to it, so it opens once you have ${MIN_SALES_FORMATTED} in sales and your first payout has completed. Nothing to apply for — it appears here on its own.`;

export const AGENT_PAGES: Record<string, PageSpec> = {
  "/agent": {
    component: "Agent/Index",
    // Authorizes the ROLE only: a seller under the earned-access bar still gets the page, locked.
    guard: (info) => sellerGuard(info, (context) => authorize(userPolicy.viewStoreAgent, context)),
    props: async (_, { context, meta }) => {
      meta.set({ title: "Agent" });
      return {
        greeting: GREETING,
        suggestions: SUGGESTIONS,
        eligible: await eligibleForStoreAgent(context.currentSeller!, railsEnv() === "development"),
        locked_heading: LOCKED_HEADING,
        locked_explanation: LOCKED_EXPLANATION,
      };
    },
  },
};
