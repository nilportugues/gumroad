// User::OmniauthCallbacksController#failure on `GET|POST /users/auth/failure`. A provider failure inside the OmniAuth middleware calls the
// action with the strategy in the Rack env; a request that arrives over HTTP, which is every request Node sees, carries none, so the
// provider-specific branches (social connect funnel, Devise's failure message) are unreachable here and the action only looks at
// `error_description` and `state`. The page for the async Twitter link state is an ERB view and stays with Rails.
import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { isPresent } from "./rails-request.ts";

const LOGIN_PATH = "/login";
const SETTINGS_PAYMENTS_PATH = "/settings/payments";
const ASYNC_LINK_TWITTER_STATE = "async_link_twitter_account";
const FOUND = 302;

function failure(input: MutationInput): ActionResult {
  const { error_description: description, state } = input.params;
  if (description !== undefined && description !== null && typeof description !== "string")
    throw new HandBackToRails("an error_description that is not a string");
  if (typeof description === "string" && isPresent(description))
    return { status: FOUND, location: SETTINGS_PAYMENTS_PATH, flash: { notice: description } };
  if (state === ASYNC_LINK_TWITTER_STATE) throw new HandBackToRails("the async Twitter link page, an ERB view");
  return { status: FOUND, location: LOGIN_PATH };
}

registerMutations(
  {
    method: "GET",
    pattern: "/users/auth/failure",
    skipForgeryProtection: true,
    run: (input) => Promise.resolve(failure(input)),
  },
  { method: "POST", pattern: "/users/auth/failure", formats: ["any"], run: (input) => Promise.resolve(failure(input)) },
);
