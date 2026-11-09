// Api::Mobile::AgentController#meta: the greeting and starter prompts of the mobile Agent tab. The conversation reads and the turns of that
// controller stay in Rails (the reads hide a claimed action from older clients, and the turns call a language model).
import { railsEnv } from "../infra/rails-env.ts";
import { eligibleForStoreAgent } from "../page-props/signed-in/policy-props.ts";
import { type MobileAuth, registerMobile, renderJson } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const FORBIDDEN = 403;

// AgentPresenter::GREETING and AgentPresenter::SUGGESTIONS
const GREETING = "Hi! Ask about your store, or tell me a change to make — I'll always check with you first.";
const SUGGESTIONS = ["How are my sales doing?", "List my products", "Create a 20% off code called LAUNCH"];

// `ensure_can_use_agent`: UserPolicy#use_store_agent? for a bearer whose owner is the seller. The role half (view_store_agent?) holds
// trivially for the seller acting as themselves, so only the earned-access bar is left.
async function meta(_input: unknown, auth: MobileAuth | null) {
  if (!(await eligibleForStoreAgent(auth!.owner, railsEnv() === "development"))) {
    // A before_action's halt: its after_actions do not run.
    return { ...renderJson({ success: false, error: "You don't have access to the store agent." }, FORBIDDEN), rescued: true };
  }
  return renderJson({ success: true, enabled: true, greeting: GREETING, suggestions: SUGGESTIONS });
}

registerMobile({ method: "GET", pattern: "/mobile/agent/meta", scopes: MOBILE_API_SCOPES, run: meta });
