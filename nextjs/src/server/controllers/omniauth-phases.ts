// The OmniAuth phases of User::OmniauthCallbacksController that do not need a provider's answer: the passthru 404 of a GET, the request
// phase of Google and Stripe Connect (OmniAuth redirects to the provider), and the callback checks that end in the failure action.
//
// A callback that gets past those checks carries a code, and the exchange for a token spends it; sign-in, sign-up and the Stripe account
// lookup that follow cannot be redone by Rails once Node has made the call. Those callbacks go to Rails whole, before anything is asked
// of the provider. Twitter (OAuth 1), YouTube, Instagram and TikTok (funnel events, feature flags) and Apple (signed cookie, ES256 client
// secret, POST callback) are not registered.
import { randomBytes } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { domainConfig } from "../page-props/domain.ts";

import { type ActionOptions, type ActionResult, HandBackToRails } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";

const PASSTHRU_PROVIDERS = ["twitter", "stripe_connect", "google_oauth2", "youtube", "instagram", "tiktok", "apple"];
const PASSTHRU_BODY = "Not found. Authentication passthru.";
const USERS_AUTH_PATH = "/users/auth";
const SIGN_IN_PATH = "/users/sign_in";
const SETTINGS_PAYMENTS_PATH = "/settings/payments";
const ASYNC_LINK_TWITTER_STATE = "async_link_twitter_account";
const STATE_BYTES = 24;
const FOUND = 302;
const NOT_FOUND = 404;

type Strategy = {
  name: string;
  // OmniAuth::Utils.camelize(name), the `kind` of Devise's failure message.
  kind: string;
  // Stripe Connect sets `provider_ignores_state`.
  checksState: boolean;
  authorizeUrl: string;
  // The callback URL the provider is told: Google's has no query string either, so both are `full_host + callback_path`.
  authorizeParams(input: MutationInput, state: string, callbackUrl: string): Record<string, string | null>;
};

// omniauth-google-oauth2's AUTHORIZE_OPTIONS: a request parameter of these names overrides the option.
const GOOGLE_OVERRIDABLE = [
  "access_type",
  "hd",
  "login_hint",
  "prompt",
  "request_visible_actions",
  "scope",
  "state",
  "redirect_uri",
  "include_granted_scopes",
  "enable_granular_consent",
  "openid_realm",
  "device_id",
  "device_name",
];
const GOOGLE_BASE_SCOPES = ["profile", "email", "openid"];
const GOOGLE_BASE_SCOPE_URL = "https://www.googleapis.com/auth/";
const GOOGLE_SCOPE = "email,profile";
const STRIPE_SCOPE = "read_write";
// Request parameters that would sit next to the symbol key of the same name in the hash the Stripe strategy builds.
const STRIPE_SHADOWED = ["state", "scope", "redirect_uri", "client_id", "response_type"];

function stringParam(input: MutationInput, name: string): string | undefined {
  const value = input.params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  return value;
}

function googleScope(raw: string): string {
  return raw
    .split(" ")
    .flatMap((item) => item.split(","))
    .map((scope) =>
      /^https?:\/\//u.test(scope) || GOOGLE_BASE_SCOPES.includes(scope) ? scope : `${GOOGLE_BASE_SCOPE_URL}${scope}`,
    )
    .join(" ");
}

const STRATEGIES: Record<string, Strategy> = {
  google_oauth2: {
    name: "google_oauth2",
    kind: "GoogleOauth2",
    checksState: true,
    authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
    authorizeParams(input, state, callbackUrl) {
      const params: Record<string, string | null> = { state, scope: GOOGLE_SCOPE };
      for (const key of GOOGLE_OVERRIDABLE) {
        const value = stringParam(input, key);
        if (value !== undefined && value !== "") params[key] = value;
      }
      params.scope = googleScope(params.scope ?? GOOGLE_SCOPE);
      params.access_type ??= "offline";
      if (params.openid_realm !== undefined) {
        params["openid.realm"] = params.openid_realm;
        delete params.openid_realm;
      }
      return {
        redirect_uri: callbackUrl,
        ...params,
        response_type: "code",
        client_id: getConfig("GOOGLE_CLIENT_ID") ?? null,
      };
    },
  },
  stripe_connect: {
    name: "stripe_connect",
    kind: "StripeConnect",
    checksState: false,
    authorizeUrl: "https://connect.stripe.com/oauth/authorize",
    authorizeParams(input, state, callbackUrl) {
      for (const key of STRIPE_SHADOWED)
        if (input.params[key] !== undefined)
          throw new HandBackToRails(`a ${key} parameter next to the one the Stripe strategy sets`);
      // `params.merge(request_params)`: every request parameter but `_method` is passed on to Stripe, the authenticity token included.
      const requested: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.params)) {
        if (key === "_method") continue;
        if (typeof value !== "string") throw new HandBackToRails(`a ${key} parameter that is not a string`);
        requested[key] = value;
      }
      return {
        redirect_uri: callbackUrl,
        state,
        scope: STRIPE_SCOPE,
        ...requested,
        response_type: "code",
        client_id: getConfig("STRIPE_CONNECT_CLIENT_ID") ?? null,
      };
    },
  },
};

// Faraday::Utils.escape: everything but letters, digits and ". ~ _ -" is percent-encoded byte by byte, and a space is a plus.
function faradayEscape(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[a-zA-Z0-9.~_-]/u.test(char)) return char;
      return char === " " ? "+" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// Faraday's NestedParamsEncoder sorts the keys; a nil value is written as the bare key.
export function faradayQuery(params: Record<string, string | null>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => (value === null ? faradayEscape(key) : `${faradayEscape(key)}=${faradayEscape(value)}`))
    .join("&");
}

// `OmniAuth.config.full_host`
function fullHost(): string {
  const { protocol, domain } = domainConfig(process.env);
  return `${protocol}://${domain}`;
}

const requestPath = (strategy: Strategy) => `${USERS_AUTH_PATH}/${strategy.name}`;
const callbackPath = (strategy: Strategy) => `${requestPath(strategy)}/callback`;

// `request.GET`: the query string alone, flat. Rack's nested syntax and repeated names are left to Rails.
function queryParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key.includes("[")) throw new HandBackToRails("a query parameter in Rack's nested syntax");
    params[key] = value;
  }
  return params;
}

// ActiveSupport's String#humanize without acronyms (config/initializers/inflections.rb declares none).
export function humanize(word: string): string {
  const text = word
    .replace(/^_+/u, "")
    .replace(/_id$/u, "")
    .replaceAll("_", " ")
    .replace(/[a-z\d]*/giu, (match) => match.toLowerCase());
  return text.replace(/^\w/u, (first) => first.toUpperCase());
}

function passthru(): ActionResult {
  return { status: NOT_FOUND, body: PASSTHRU_BODY, contentType: "text/plain; charset=utf-8" };
}

function assertHtml(input: MutationInput): void {
  if (requestFormat(input.request) !== "html") throw new HandBackToRails("a request whose format is not HTML");
}

// OmniAuth::Strategy#request_call then the strategy's request_phase. The CSRF token was checked on the way in (omniauth-rails_csrf_protection
// raises otherwise, and Rails answers that in the failure action, which Node leaves to Rails). Provider failures of this phase do not exist.
function requestPhase(strategy: Strategy) {
  return (input: MutationInput): Promise<ActionResult> => {
    assertHtml(input);
    const { session } = input.chain;
    const state = randomBytes(STATE_BYTES).toString("hex");
    const authorize = strategy.authorizeParams(input, state, `${fullHost()}${callbackPath(strategy)}`);
    // Google takes the state from a request parameter when there is one, and stores that one.
    const sentState = authorize.state ?? state;

    const origin = stringParam(input, "origin");
    const referer = input.request.headers.get("referer");
    session.data["omniauth.params"] = queryParams(input.url);
    if (origin !== undefined) session.data["omniauth.origin"] = origin;
    else if (referer !== null && !new RegExp(`${requestPath(strategy)}$`, "mu").test(referer))
      session.data["omniauth.origin"] = referer;
    session.data["omniauth.state"] = sentState;

    const location = `${strategy.authorizeUrl}?${faradayQuery(authorize)}`;
    // Rack::Response#redirect: no content type.
    return Promise.resolve({
      status: FOUND,
      body: `Redirecting to ${location}...`,
      contentType: "",
      headers: { location },
    });
  };
}

// OmniAuth::Strategies::OAuth2#callback_phase up to the exchange. Returns the failure it ends in, or null when the code would be exchanged.
function callbackFailure(strategy: Strategy, input: MutationInput): { type: string; reason: string | null } | null {
  const session = input.chain.session.data;
  const error = stringParam(input, "error_reason") ?? stringParam(input, "error");
  const state = stringParam(input, "state") ?? "";
  // `session.delete` is skipped when the state is empty, as `||` short-circuits.
  const stored = strategy.checksState && state !== "" ? session["omniauth.state"] : undefined;
  if (strategy.checksState && state !== "") delete session["omniauth.state"];
  const stateFails = strategy.checksState && (state === "" || state !== stored);
  delete session["omniauth.origin"];
  delete session["omniauth.params"];
  if (stateFails) return { type: "csrf_detected", reason: "CSRF detected" };
  if (error !== undefined)
    return {
      type: error,
      reason:
        stringParam(input, "error_description") ??
        stringParam(input, "error_reason") ??
        stringParam(input, "error") ??
        error,
    };
  return null;
}

// Devise::OmniauthCallbacksController#failure through User::OmniauthCallbacksController#failure, for a strategy that is no social connect.
function failure(strategy: Strategy, input: MutationInput, type: string, reason: string | null): ActionResult {
  const description = stringParam(input, "error_description");
  if (description !== undefined && isPresent(description))
    return { status: FOUND, location: SETTINGS_PAYMENTS_PATH, flash: { notice: description } };
  if (stringParam(input, "state") === ASYNC_LINK_TWITTER_STATE)
    throw new HandBackToRails("the async Twitter link page, an ERB view");
  return {
    status: FOUND,
    location: SIGN_IN_PATH,
    flash: { alert: `Could not authenticate you from ${strategy.kind} because "${humanize(reason ?? type)}".` },
  };
}

function callbackPhase(strategy: Strategy) {
  return (input: MutationInput): Promise<ActionResult> => {
    assertHtml(input);
    // Work on a copy: a request that is handed back must leave the session as Rails will find it.
    const chain = input.chain;
    const saved = { ...chain.session.data };
    const failed = callbackFailure(strategy, input);
    if (failed === null) {
      chain.session.data = saved;
      throw new HandBackToRails("a callback with a code to exchange");
    }
    try {
      return Promise.resolve(failure(strategy, input, failed.type, failed.reason));
    } catch (error) {
      chain.session.data = saved;
      throw error;
    }
  };
}

const BARE: ActionOptions = { bare: true, metal: true, skip: ["redirect_to_custom_subdomain", "check_suspended"] };

registerMutations(
  ...PASSTHRU_PROVIDERS.map((name) => ({
    method: "GET",
    pattern: `${USERS_AUTH_PATH}/${name}`,
    skipForgeryProtection: true,
    run: (input: MutationInput) => {
      assertHtml(input);
      delete input.chain.session.data.social_connect_return;
      return Promise.resolve(passthru());
    },
  })),
  ...Object.values(STRATEGIES).flatMap((strategy) => [
    { method: "POST", pattern: requestPath(strategy), options: BARE, run: requestPhase(strategy) },
    { method: "GET", pattern: callbackPath(strategy), skipForgeryProtection: true, run: callbackPhase(strategy) },
  ]),
);
