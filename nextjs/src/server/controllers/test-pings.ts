// TestPingsController#create (app/controllers/test_pings_controller.rb): the "Send test ping" button of the advanced settings. Node answers
// the guards and the invalid URL; anything that would make Rails call the seller's endpoint is handed back whole.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { accountEmailRequired, json } from "./seller-json.ts";

const INVALID_URL_MESSAGE = "That URL seems to be invalid.";
const FAILED_MESSAGE = "Sorry, something went wrong. Please try again.";

async function create(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const emailRequired = accountEmailRequired(input);
  if (emailRequired) return emailRequired;
  // The action's `rescue Exception` also catches Pundit::NotAuthorizedError, so a refusal is a 200 here and not PunditAuthorization's 401.
  try {
    authorize(settingsAdvancedUserPolicy.testPing, await loadSellerContext(input.context));
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return json({ success: false, error_message: FAILED_MESSAGE });
  }

  const url = input.params.url;
  // URI::DEFAULT_PARSER.make_regexp only matches absolute URIs, which have a scheme and so a colon. Whether a string with one is valid is the
  // regexp's call, and a valid one makes Rails send the ping.
  if (url === undefined || url === null || (typeof url === "string" && !url.includes(":")))
    return json({ success: false, error_message: INVALID_URL_MESSAGE });
  // A non-empty list of strings reaches Regexp#match? as an Array, which raises TypeError into the action's `rescue Exception`. Other
  // non-strings (numbers, objects) take the same road but have no recording, so they stay handed back.
  if (Array.isArray(url) && url.length > 0 && url.every((entry) => typeof entry === "string"))
    return json({ success: false, error_message: FAILED_MESSAGE });
  throw new HandBackToRails("a ping URL that needs the URI regexp and the HTTP call");
}

registerMutations({ method: "POST", pattern: "/test_pings", json: true, run: create });
