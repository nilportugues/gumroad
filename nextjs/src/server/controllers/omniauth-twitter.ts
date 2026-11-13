// The Twitter (X) strategy of OmniAuth (omniauth-twitter over omniauth-oauth, OAuth 1.0a): the request phase (a signed request token call, then
// the redirect to Twitter), and the callback that trades the verifier for an access token, verifies the credentials and links the account of a
// signed-in seller, or signs a visitor in or up (User::OmniauthCallbacksController#twitter).
//
// The verifier is spent by the access token call, so what Node cannot finish afterwards is handed back to Rails before it: the async link (an
// ERB page that closes the window), and a login of a visitor who is already signed in or that merges a guest cart. See parity-debt.md.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isBlank } from "../html/text-helper.ts";
import { getConfig } from "../infra/config.ts";
import { OAuth1Timeout, parseTokenAnswer, signedRequest } from "../infra/oauth1.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { recordSocialConnectEvent } from "../models/social-connect-funnel.ts";
import { findOrCreateForTwitterOauth, linkTwitterAccount, TwitterPayloadError } from "../models/social-twitter.ts";
import { isDeleted, isFlagSet, Users } from "../models/user.ts";
import { createUserEvent } from "../page-props/audience/events.ts";
import { domainConfig } from "../page-props/domain.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { prepareTwoFactorAuthentication, resetTwoFactorSession } from "./auth-mutations.ts";
import { signedInUserHome } from "./auth-pages.ts";
import { assertNoGuestCart, refreshPasskeySetupPrompt, rememberedTwoFactor, signIn } from "./auth-session.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import {
  assertHtml,
  BARE,
  consumeSocialConnectReturn,
  formCallback,
  fullHost,
  humanize,
  isHash,
  queryParams,
  sanitizeOauthError,
  sessionHash,
  stringParam,
} from "./omniauth-phases.ts";
import { cgiEscape, safeRedirectPath } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { resolveRequestAuth } from "./signed-in-filters.ts";

const TWITTER = "https://api.twitter.com";
const REQUEST_PATH = "/users/auth/twitter";
const CALLBACK_PATH = `${REQUEST_PATH}/callback`;
const FOUND = 302;
const LINK_STATE = "link_twitter_account";
const ASYNC_LINK_STATE = "async_link_twitter_account";
const LINK_STATES = [LINK_STATE, ASYNC_LINK_STATE];
const SIGN_IN_PATH = "/users/sign_in";
const LOGIN_PATH = "/login";
const SETTINGS_PAYMENTS_PATH = "/settings/payments";
const SOCIAL_CONNECTIONS_PATH = "/settings/social_connections";
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;
const HTTP_CLIENT_ERROR_MINIMUM = 400;
const HTTP_CLIENT_ERROR_LIMIT = 500;
const HTTP_SERVER_ERROR_LIMIT = 600;
const CREDENTIALS_URL = `${TWITTER}/1.1/account/verify_credentials.json?include_entities=false&skip_status=true&include_email=true`;
const LOGIN_HINTS = ["force_login", "lang", "screen_name"];
const SETTINGS_PATH = "/settings";
const TWO_FACTOR_PATH = "/two-factor";
const ADMIN_LOGIN_ERROR = "You're an admin, you can't login with Twitter.";
const DELETED_ACCOUNT_LOGIN_ERROR =
  "You cannot log in because your account was deleted. Email support@gumroad.com if you'd like to use this email address for a new account.";

// OmniAuth's `fail!` ends in the failure action; this is User::OmniauthCallbacksController#failure for the Twitter strategy.
type Failure = { type: string };

// URI.encode_www_form
function encodeForm(pairs: [string, string][]): string {
  return new URLSearchParams(pairs).toString().replaceAll("%7E", "~").replaceAll("*", "%2A");
}

const secrets = () => ({ key: getConfig("TWITTER_APP_ID"), secret: getConfig("TWITTER_APP_SECRET") });

function rawQuery(input: MutationInput): string {
  const target = input.rawTarget ?? `${input.url.pathname}${input.url.search}`;
  const index = target.indexOf("?");
  return index === -1 ? "" : target.slice(index + 1);
}

function redirectTo(location: string): ActionResult {
  // Rack::Response#redirect: no content type.
  return { status: FOUND, body: `Redirecting to ${location}...`, contentType: "", headers: { location } };
}

async function failureAction(
  input: MutationInput,
  { type }: Failure,
  omniauthParams: Record<string, unknown> | null,
): Promise<ActionResult> {
  const { chain } = input;
  const user = railsLoggedInUser(chain.auth.context);
  const linkState = omniauthParams?.state === LINK_STATE;
  // set_social_connect_destination runs ahead of the failure action when the connect was a link.
  const destination = linkState ? await consumeSocialConnectReturn(chain, omniauthParams) : null;
  const requestState = stringParam(input, "state") ?? "";
  if (LINK_STATES.includes(requestState) && user) {
    const error = stringParam(input, "error");
    await recordSocialConnectEvent({
      userId: user.id,
      stage: "failed",
      provider: "twitter",
      surface: "omniauth",
      extra: sanitizeOauthError(error !== undefined && isPresent(error) ? error : type),
      now: () => chain.now,
    });
  }
  if (linkState && user)
    return {
      status: FOUND,
      location: destination ?? SOCIAL_CONNECTIONS_PATH,
      flash: { alert: "Couldn't connect X. Please try again." },
    };
  const description = stringParam(input, "error_description");
  if (description !== undefined && isPresent(description))
    return { status: FOUND, location: SETTINGS_PAYMENTS_PATH, flash: { notice: description } };
  if (requestState === ASYNC_LINK_STATE) throw new HandBackToRails("the async Twitter link page, an ERB view");
  return {
    status: FOUND,
    location: SIGN_IN_PATH,
    flash: { alert: `Could not authenticate you from Twitter because "${humanize(type)}".` },
  };
}

async function requestPhase(input: MutationInput): Promise<ActionResult> {
  assertHtml(input);
  const { session } = input.chain;
  const params = queryParams(input.url);
  if (input.params.callback_url !== undefined) throw new HandBackToRails("a callback_url of its own");

  const authorizeParams: [string, string][] = [];
  for (const name of LOGIN_HINTS) {
    const value = stringParam(input, name);
    if (value !== undefined) authorizeParams.push([name, value]);
  }
  const accessType = stringParam(input, "x_auth_access_type");
  const useAuthorize = stringParam(input, "use_authorize") === "true";

  const linking = LINK_STATES.includes(params.state ?? "");
  // The funnel hook asks Warden for the user only for a link request.
  const auth = linking ? await resolveRequestAuth(input.request, input.chain.now) : null;
  if (auth && (auth.authenticatedVia === "remember_cookie" || auth.effects.signOut))
    throw new HandBackToRails("a visitor Devise signs in or out on the way");

  session.data["omniauth.params"] = params;
  const warden = auth?.context.loggedInUser;
  const origin = stringParam(input, "origin");
  const referer = input.request.headers.get("referer");
  if (origin !== undefined) session.data["omniauth.origin"] = origin;
  else if (referer !== null && !new RegExp(`${REQUEST_PATH}$`, "mu").test(referer))
    session.data["omniauth.origin"] = referer;

  const { key, secret } = secrets();
  if (!key || !secret) throw new HandBackToRails("no Twitter consumer credentials");
  const query = rawQuery(input);
  const callback = `${fullHost()}${CALLBACK_PATH}${query === "" ? "" : `?${query}`}`;
  let answer;
  try {
    answer = await signedRequest({
      method: "POST",
      url: new URL(`${TWITTER}/oauth/request_token`),
      consumerKey: key,
      consumerSecret: secret,
      callback,
      form: accessType === undefined ? [] : [["x_auth_access_type", accessType]],
      now: input.chain.now,
    });
  } catch (error) {
    // The failure action of a request phase is a full controller chain, which this bare route is not; the call is safe to repeat.
    throw new HandBackToRails(
      error instanceof OAuth1Timeout
        ? "a request token call that timed out"
        : "a request token call that failed to connect",
    );
  }
  if (answer.status < HTTP_SUCCESS_MINIMUM || answer.status >= HTTP_SUCCESS_LIMIT)
    throw new HandBackToRails("a request token call Twitter refused, redirected or could not serve");
  const token = parseTokenAnswer(answer.text);
  if (token.oauth_callback_confirmed !== "true" || !token.oauth_token || token.oauth_token_secret === undefined)
    throw new HandBackToRails("a request token answer without a confirmed callback");

  // Written once nothing can hand the request back: Rails would record it again.
  if (warden)
    await recordSocialConnectEvent({
      userId: warden.id,
      stage: "attempted",
      provider: "twitter",
      surface: "omniauth",
      now: () => input.chain.now,
    });

  const oauth = isHash(session.data.oauth) ? session.data.oauth : {};
  oauth.twitter = {
    callback_confirmed: true,
    request_token: token.oauth_token,
    request_secret: token.oauth_token_secret,
  };
  session.data.oauth = oauth;
  // request_token.authorize_url(options[:authorize_params]): the hints, then the token.
  const base = `${TWITTER}/oauth/${useAuthorize ? "authorize" : "authenticate"}`;
  return redirectTo(`${base}?${encodeForm([...authorizeParams, ["oauth_token", token.oauth_token]])}`);
}

async function callbackPhase(input: MutationInput): Promise<ActionResult> {
  assertHtml(input);
  const { chain } = input;
  const saved = structuredClone(chain.session.data);
  try {
    const omniauthParams = sessionHash(chain, "omniauth.params");
    const origin = chain.session.data["omniauth.origin"];
    delete chain.session.data["omniauth.origin"];
    delete chain.session.data["omniauth.params"];
    const oauth = chain.session.data.oauth;
    // `fail(OmniAuth::NoSessionError)` when no request phase came before.
    if (oauth === undefined || oauth === null)
      return await failureAction(input, { type: "session_expired" }, omniauthParams);
    if (!isHash(oauth) || !isHash(oauth.twitter) || oauth.twitter.callback_confirmed !== true)
      throw new HandBackToRails("a session whose request token is not the one this port writes");
    if (omniauthParams.state === ASYNC_LINK_STATE)
      throw new HandBackToRails("the async Twitter link page, an ERB view");
    const linking = omniauthParams.state === LINK_STATE;
    if (input.params.callback_url !== undefined || omniauthParams.callback_url !== undefined)
      throw new HandBackToRails("a callback_url of its own");
    const user = railsLoggedInUser(chain.auth.context);
    if (!linking) {
      if (user) throw new HandBackToRails("a login callback of a visitor who is signed in");
      // sign_in_or_prepare_for_two_factor_auth merges the cart of this browser into the user's.
      await assertNoGuestCart(chain);
    }
    if (chain.auth.effects.signOut || chain.auth.authenticatedVia === "remember_cookie")
      throw new HandBackToRails("a visitor Devise signs in or out on the way");
    const { key, secret } = secrets();
    if (!key || !secret) throw new HandBackToRails("no Twitter consumer credentials");

    const entry = oauth.twitter;
    const requestToken = { token: String(entry.request_token), secret: String(entry.request_secret) };
    delete entry.request_token;
    delete entry.request_secret;
    const verifier = stringParam(input, "oauth_verifier");

    // From here the verifier is spent: nothing below may hand back.
    let access: { token: string; secret: string };
    let data: Record<string, unknown>;
    try {
      const answer = await signedRequest({
        method: "POST",
        url: new URL(`${TWITTER}/oauth/access_token`),
        consumerKey: key,
        consumerSecret: secret,
        token: requestToken,
        verifier,
        now: chain.now,
      });
      if (answer.status >= HTTP_CLIENT_ERROR_MINIMUM && answer.status < HTTP_CLIENT_ERROR_LIMIT)
        return await failureAction(input, { type: "invalid_credentials" }, omniauthParams);
      if (answer.status >= HTTP_SERVER_ERROR_LIMIT - 100 && answer.status < HTTP_SERVER_ERROR_LIMIT)
        return await failureAction(input, { type: "service_unavailable" }, omniauthParams);
      if (answer.status < HTTP_SUCCESS_MINIMUM || answer.status >= HTTP_SUCCESS_LIMIT)
        throw new NotPorted("a redirect from the access token call");
      const parsed = parseTokenAnswer(answer.text);
      access = { token: parsed.oauth_token ?? "", secret: parsed.oauth_token_secret ?? "" };
      const profile = await signedRequest({
        method: "GET",
        url: new URL(CREDENTIALS_URL),
        consumerKey: key,
        consumerSecret: secret,
        token: access,
        now: chain.now,
      });
      try {
        const body = JSON.parse(profile.text) as unknown;
        if (!isHash(body)) throw new Error("not an object");
        data = body;
      } catch {
        throw new NotPorted("a verify_credentials answer that is not a JSON object");
      }
    } catch (error) {
      if (error instanceof OAuth1Timeout) return await failureAction(input, { type: "timeout" }, omniauthParams);
      throw error;
    }

    if (!linking) return await loginOrSignup(input, data, access, omniauthParams, origin);

    // set_social_connect_destination
    const destination = await consumeSocialConnectReturn(chain, omniauthParams);
    if (!user)
      return {
        status: FOUND,
        location: LOGIN_PATH,
        flash: { alert: "You need to be logged in to link your X account." },
      };
    try {
      await linkTwitterAccount(user.id, data, access, () => chain.now);
    } catch (error) {
      if (error instanceof TwitterPayloadError) throw new NotPorted(error.message);
      throw error;
    }
    return { status: FOUND, location: destination ?? SOCIAL_CONNECTIONS_PATH };
  } catch (error) {
    if (error instanceof HandBackToRails) chain.session.data = saved;
    throw error;
  }
}

// User::OmniauthCallbacksController#twitter, the part that is not a link: `find_or_create_for_twitter_oauth!`, the credentials saved on the
// user, then a sign-in (through two-factor authentication when the account has it) or a redirect that says why not.
async function loginOrSignup(
  input: MutationInput,
  info: Record<string, unknown>,
  credentials: { token: string; secret: string },
  omniauthParams: Record<string, unknown>,
  origin: unknown,
): Promise<ActionResult> {
  const { chain } = input;
  const now = () => chain.now;
  // set_social_connect_destination for an action that connects nothing: the pending return entry is dropped.
  delete chain.session.data.social_connect_return;
  let user;
  try {
    user = await findOrCreateForTwitterOauth(info, now);
  } catch (error) {
    // `save!` raises RecordInvalid and the payload's `errors` loop raises NoMethodError: Rails answers a 500, after the verifier was spent.
    if (error instanceof RecordInvalid || error instanceof TwitterPayloadError)
      throw new NotPorted((error as Error).message);
    throw error;
  }
  // update_twitter_oauth_credentials_for
  user.assign({ twitter_oauth_token: credentials.token, twitter_oauth_secret: credentials.secret });
  await Users.saveBang(user, { now });

  if (isFlagSet(user, "is_team_member"))
    return { status: FOUND, location: LOGIN_PATH, flash: { alert: ADMIN_LOGIN_ERROR } };
  if (isDeleted(user)) return { status: FOUND, location: LOGIN_PATH, flash: { alert: DELETED_ACCOUNT_LOGIN_ERROR } };

  const ip = remoteIp(input.request);
  if (ip === null) throw new NotPorted("a request with no client address");
  const cookies: string[] = [];
  if (!isBlank(user.get("email"))) {
    // sign_in_or_prepare_for_two_factor_auth
    const remembered = isFlagSet(user, "two_factor_authentication_enabled")
      ? await rememberedTwoFactor(chain, user, ip)
      : { skip: true, cookies: [] };
    if (remembered.skip) {
      cookies.push(...remembered.cookies, ...(await signIn(chain, user, { remember: false, remoteIp: ip })));
      resetTwoFactorSession(chain);
      await refreshPasskeySetupPrompt(chain, user);
    } else await prepareTwoFactorAuthentication(chain, user, input.params);
    const next = await postAuthRedirect(input, user.get("id"), omniauthParams, origin);
    // safe_redirect_to two_factor_authentication_path(next: ...)
    const { rootDomain } = domainConfig(process.env);
    const location = safeRedirectPath(`${TWO_FACTOR_PATH}?next=${cgiEscape(next)}`, chain.request, { rootDomain });
    return { status: FOUND, location, cookies };
  }

  cookies.push(...(await signIn(chain, user, { remember: false, remoteIp: ip })));
  if (!isBlank(user.get("unconfirmed_email")))
    return {
      status: FOUND,
      location: SETTINGS_PATH,
      cookies,
      flash: { warning: "Please confirm your email address" },
    };
  await createUserEvent("signup", {
    context: chain.auth.context,
    headers: input.request.headers,
    url: input.url,
    state: input.peekState(),
    signup: { userId: user.get("id") },
  });
  return { status: FOUND, location: SETTINGS_PATH, cookies, flash: { warning: "Please enter an email address!" } };
}

// post_auth_redirect: the page the flow started from, else the user's home.
async function postAuthRedirect(
  input: MutationInput,
  userId: bigint,
  omniauthParams: Record<string, unknown>,
  origin: unknown,
): Promise<string> {
  const { chain } = input;
  const requested = stringParam(input, "referer");
  const stored = omniauthParams.referer;
  const referer = requested !== undefined && isPresent(requested) ? requested : (stored ?? origin);
  const { rootDomain } = domainConfig(process.env);
  const target =
    typeof referer === "string" && isPresent(referer) && referer !== "/" ? referer : await signedInUserHome(userId);
  return safeRedirectPath(target, chain.request, { rootDomain });
}

// An exception Ruby raises after the verifier was spent, which Rails answers with a 500.
class NotPorted extends Error {
  constructor(what: string) {
    super(`not ported: ${what}`);
    this.name = "NotPorted";
  }
}

registerMutations(
  { method: "POST", pattern: REQUEST_PATH, options: BARE, run: requestPhase },
  { method: "GET", pattern: CALLBACK_PATH, skipForgeryProtection: true, run: callbackPhase },
  { method: "POST", pattern: CALLBACK_PATH, run: formCallback(callbackPhase) },
);
