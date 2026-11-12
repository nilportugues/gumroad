// The Google callback (omniauth-google-oauth2's callback phase, then User::OmniauthCallbacksController#google_oauth2 over
// User.find_or_create_for_google_oauth2). The request phase and the checks that end in the failure action are omniauth-phases.ts's.
//
// Google's code is single-use and the account is judged from the answer it buys, so a request Node cannot finish is handed back to Rails before
// the exchange, and nothing after it may throw: the request could not be repeated. A failure of the exchange or of the auth hash ends in the
// failure action, as in OmniAuth. An error Node did not foresee (a shape of data the port does not reproduce) ends there as well, reported,
// where Rails would answer 500.
import { notifyError } from "../infra/error-reporting.ts";
import { googleAuthData } from "../models/social-google-auth.ts";
import { findOrCreateForGoogleOauth2 } from "../models/social-google.ts";
import { isDeleted } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { signedInUserHome } from "./auth-pages.ts";
import { signIn } from "./auth-session.ts";
import { type MutationInput, remoteIp } from "./mutation.ts";
import { authFailure, type CodeCallbackContext, registerCodeCallback, stringParam } from "./omniauth-phases.ts";
import { safeRedirectPath } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { exchangeGoogleLogin } from "./social-connect-exchange.ts";

const STRATEGY = "google_oauth2";
const FOUND = 302;
const LOGIN_PATH = "/login";
const SIGNUP_PATH = "/signup";
const ASYNC_LINK_TWITTER_STATE = "async_link_twitter_account";
const INTERNAL_ERROR = "internal_error";
const DELETED_ACCOUNT_LOGIN_ERROR =
  "You cannot log in because your account was deleted. Email support@gumroad.com if you'd like to use this email address for a new account.";

// What changes the request OmniAuth and Rails would have answered differently, or whose answer depends on the exchange: all before the code
// is spent.
function assertFinishable(input: MutationInput): string {
  const { chain } = input;
  if (
    chain.auth.context.loggedInUser ||
    chain.auth.effects.signOut ||
    chain.auth.authenticatedVia === "remember_cookie"
  )
    throw new HandBackToRails("a visitor who is signed in");
  const code = stringParam(input, "code");
  if (code === undefined || !isPresent(code)) throw new HandBackToRails("a callback without a code");
  // omniauth-google-oauth2's get_access_token: an XHR sends the code to Google as is, and a redirect_uri of its own replaces the callback's.
  if (input.request.headers.get("x-requested-with") === "XMLHttpRequest") throw new HandBackToRails("an XHR callback");
  if (stringParam(input, "redirect_uri") !== undefined)
    throw new HandBackToRails("a callback that names a redirect URI");
  // The failure action reads these two, and the exchange may fail.
  if (stringParam(input, "state") === ASYNC_LINK_TWITTER_STATE)
    throw new HandBackToRails("the async Twitter link page, an ERB view");
  const description = stringParam(input, "error_description");
  if (description !== undefined && isPresent(description))
    throw new HandBackToRails("a callback with an error description");
  return code;
}

// User::OmniauthCallbacksController#post_auth_redirect
async function postAuthRedirect(input: MutationInput, context: CodeCallbackContext, userId: bigint): Promise<string> {
  const { chain } = input;
  const { rootDomain } = domainConfig(process.env);
  const requested = stringParam(input, "referer");
  const referer =
    requested !== undefined && isPresent(requested) ? requested : (context.omniauthParams.referer ?? context.origin);
  const target =
    typeof referer === "string" && isPresent(referer) && referer !== "/" ? referer : await signedInUserHome(userId);
  const once = safeRedirectPath(target, chain.request, { rootDomain });
  return safeRedirectPath(once, chain.request, { rootDomain });
}

async function callback(input: MutationInput, context: CodeCallbackContext): Promise<ActionResult> {
  const { chain } = input;
  const code = assertFinishable(input);
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");

  // From here the code is spent.
  try {
    const login = await exchangeGoogleLogin(code, context.callbackUrl, chain.now);
    if (!login.ok) return authFailure(STRATEGY, input, login.type, login.type);

    let data;
    try {
      data = googleAuthData(login.rawInfo);
    } catch (error) {
      // The auth hash is built inside the strategy: whatever Ruby raises there ends in `fail!(e.message)`.
      return authFailure(STRATEGY, input, (error as Error).message, (error as Error).message);
    }

    const user = await findOrCreateForGoogleOauth2(data, () => chain.now);
    if (user === null || user.newRecord) {
      return {
        status: FOUND,
        location: SIGNUP_PATH,
        flash: { alert: "Sorry, something went wrong. Please try again." },
      };
    }
    if (isDeleted(user)) return { status: FOUND, location: LOGIN_PATH, flash: { alert: DELETED_ACCOUNT_LOGIN_ERROR } };

    const cookies = await signIn(chain, user, { remember: false, remoteIp: ip });
    return { status: FOUND, location: await postAuthRedirect(input, context, user.get("id")), cookies };
  } catch (error) {
    notifyError(error);
    return authFailure(STRATEGY, input, INTERNAL_ERROR, INTERNAL_ERROR);
  }
}

registerCodeCallback(STRATEGY, callback);
