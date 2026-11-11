// Api::Mobile::AgentController#meta, #latest_conversation and #turn_status: the greeting and starter prompts of the mobile Agent tab and
// its two conversation reads, which share their bodies with the web reads (internal-agent.ts). The turns (#create, #execute and
// AgentStreamsController#create) run the Redis-counted `throttle_agent_requests` before any other check, so a Node answer would skip
// that counter: they answer the 401/403 gates here and hand every request that passes back whole.
import { railsEnv } from "../infra/rails-env.ts";
import { eligibleForStoreAgent } from "../page-props/signed-in/policy-props.ts";

import { HandBackToRails } from "./application-controller.ts";
import { latestConversation, turnStatus } from "./internal-agent.ts";
import { type MobileAuth, registerMobile, renderJson } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const FORBIDDEN = 403;

// AgentPresenter::GREETING and AgentPresenter::SUGGESTIONS
const GREETING = "Hi! Ask about your store, or tell me a change to make — I'll always check with you first.";
const SUGGESTIONS = ["How are my sales doing?", "List my products", "Create a 20% off code called LAUNCH"];

// `ensure_can_use_agent`: UserPolicy#use_store_agent? for a bearer whose owner is the seller. The role half (view_store_agent?) holds
// trivially for the seller acting as themselves, so only the earned-access bar is left.
async function ensureCanUseAgent(auth: MobileAuth | null) {
  if (await eligibleForStoreAgent(auth!.owner, railsEnv() === "development")) return null;
  // A before_action's halt: its after_actions do not run.
  return {
    ...renderJson({ success: false, error: "You don't have access to the store agent." }, FORBIDDEN),
    rescued: true,
  };
}

async function meta(_input: unknown, auth: MobileAuth | null) {
  return (
    (await ensureCanUseAgent(auth)) ??
    renderJson({ success: true, enabled: true, greeting: GREETING, suggestions: SUGGESTIONS })
  );
}

async function latest(_input: unknown, auth: MobileAuth | null) {
  return (await ensureCanUseAgent(auth)) ?? latestConversation(auth!.owner.id, true);
}

async function turn(input: { routeParams: Record<string, string> }, auth: MobileAuth | null) {
  return (await ensureCanUseAgent(auth)) ?? turnStatus(auth!.owner.id, input.routeParams.client_turn_id!, true);
}

const handedBackTurn = (what: string) => async (_input: unknown, auth: MobileAuth | null) => {
  const refused = await ensureCanUseAgent(auth);
  if (refused) return refused;
  throw new HandBackToRails(what);
};

registerMobile(
  { method: "GET", pattern: "/mobile/agent/meta", scopes: MOBILE_API_SCOPES, run: meta },
  { method: "GET", pattern: "/mobile/agent/conversations/latest", scopes: MOBILE_API_SCOPES, run: latest },
  { method: "GET", pattern: "/mobile/agent/turns/:client_turn_id", scopes: MOBILE_API_SCOPES, run: turn },
  {
    method: "POST",
    pattern: "/mobile/agent/messages",
    scopes: MOBILE_API_SCOPES,
    run: handedBackTurn("an agent turn"),
  },
  {
    method: "POST",
    pattern: "/mobile/agent/messages/stream",
    scopes: MOBILE_API_SCOPES,
    run: handedBackTurn("a streamed agent turn"),
  },
  {
    method: "POST",
    pattern: "/mobile/agent/actions",
    scopes: MOBILE_API_SCOPES,
    run: handedBackTurn("a confirmed agent action"),
  },
);
