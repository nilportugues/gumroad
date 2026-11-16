// Oauth::MobilePreAuthorizationsController, for a visitor who is not signed in: both actions redirect to /oauth/authorize with the query
// string untouched. A signed-in visitor gets the account chooser, an ERB view (#new), or is signed out (#switch_account), which are Rails'.
import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { setCookieHeader } from "./rack-cookies.ts";

const AUTHORIZE_PATH = "/oauth/authorize";
const MOBILE_APP_COOKIE = "is_gumroad_mobile_app";
const MOBILE_APP_COOKIE_LIFETIME_MS = 5 * 60 * 1000;
const FOUND = 302;

// `redirect_to "/oauth/authorize?#{request.query_string}"`: the "?" stays when the query string is empty.
const authorizeLocation = (input: MutationInput) => `${AUTHORIZE_PATH}?${input.request.queryString}`;

function assertSignedOut(input: MutationInput): void {
  if (input.context.loggedInUser !== null)
    throw new HandBackToRails("a signed-in visitor on the mobile pre-authorization page");
}

function newPreAuthorization(input: MutationInput): ActionResult {
  assertSignedOut(input);
  const cookie = setCookieHeader(MOBILE_APP_COOKIE, {
    value: "1",
    path: "/",
    expires: new Date(input.chain.now.getTime() + MOBILE_APP_COOKIE_LIFETIME_MS),
    secure: true,
    sameSite: "none",
  });
  return { status: FOUND, location: authorizeLocation(input), cookies: [cookie] };
}

function switchAccount(input: MutationInput): ActionResult {
  assertSignedOut(input);
  return { status: FOUND, location: authorizeLocation(input) };
}

registerMutations(
  {
    method: "GET",
    pattern: "/oauth/mobile_pre_authorization/new",
    skipForgeryProtection: true,
    run: (input) => Promise.resolve(newPreAuthorization(input)),
  },
  {
    method: "GET",
    pattern: "/oauth/mobile_pre_authorization/switch_account",
    skipForgeryProtection: true,
    run: (input) => Promise.resolve(switchAccount(input)),
  },
);
