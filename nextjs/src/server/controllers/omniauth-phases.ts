// The OmniAuth phases of User::OmniauthCallbacksController that do not need a provider's answer: the passthru 404 of a GET, the request
// phase of Google and Stripe Connect (OmniAuth redirects to the provider), and the callback checks that end in the failure action.
//
// A callback that gets past those checks carries a code, and the exchange for a token spends it; sign-in, sign-up and the Stripe account
// lookup that follow cannot be redone by Rails once Node has made the call. Those callbacks go to Rails whole, before anything is asked
// of the provider. Twitter (OAuth 1) and Apple (signed cookie, ES256 client secret, POST callback) are not registered.
//
// YouTube, Instagram and TikTok (the social connects) add three things to the same phases: a feature flag that each strategy checks in the
// middleware (a disabled one answers before the provider is asked), the `attempted` funnel event, and a failure action that records
// `failed`, flashes and returns to the page the connect started from (SocialConnectReturn).
import { randomBytes } from "node:crypto";

import { type ResolvedAuth, railsLoggedInUser } from "../auth/resolve.ts";
import { getConfig } from "../infra/config.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { recordSocialConnectEvent } from "../models/social-connect-funnel.ts";
import { domainConfig } from "../page-props/domain.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { settingsSocialConnectionsPolicy } from "../policies/settings/social-connections.ts";

import {
  type ActionOptions,
  type ActionResult,
  type Chain,
  HandBackToRails,
  type Redirected,
} from "./application-controller.ts";
import { faradayQuery } from "./faraday-query.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { resolveRequestAuth } from "./signed-in-filters.ts";
import { connectAccount, exchangeCode, type SocialProvider } from "./social-connect-exchange.ts";

const PASSTHRU_PROVIDERS = ["twitter", "stripe_connect", "google_oauth2", "youtube", "instagram", "tiktok", "apple"];
const PASSTHRU_BODY = "Not found. Authentication passthru.";
const USERS_AUTH_PATH = "/users/auth";
const SIGN_IN_PATH = "/users/sign_in";
const SETTINGS_PAYMENTS_PATH = "/settings/payments";
const ASYNC_LINK_TWITTER_STATE = "async_link_twitter_account";
const STATE_BYTES = 24;
const FOUND = 302;
const NOT_FOUND = 404;
const LOGIN_PATH = "/login";
const SOCIAL_CONNECTIONS_PATH = "/settings/social_connections";
const SOCIAL_CONNECT_RETURN = "social_connect_return";
// SocialConnectReturn::RETURN_LIFETIME
const RETURN_LIFETIME_SECONDS = 15 * 60;
const SANITIZED_ERROR_LIMIT = 64;
const UNAVAILABLE = "social_connect_unavailable";
const YOUTUBE_SCOPE = "email,profile,https://www.googleapis.com/auth/youtube.readonly";
const INSTAGRAM_SCOPE = "instagram_business_basic";
const TIKTOK_SCOPE = "user.info.basic,user.info.profile,user.info.stats";
const TIKTOK_ALWAYS_SHOW_AUTHORIZATION = "1";

type Strategy = {
  name: string;
  // OmniAuth::Utils.camelize(name), the `kind` of Devise's failure message.
  kind: string;
  // Stripe Connect sets `provider_ignores_state`.
  checksState: boolean;
  authorizeUrl: string;
  // The callback URL the provider is told: Google's has no query string either, so both are `full_host + callback_path`.
  authorizeParams(input: MutationInput, state: string, callbackUrl: string): Record<string, string | null>;
  // The query string of the redirect to the provider: Faraday's sorted one unless the strategy builds its own.
  encodeQuery?: (params: Record<string, string | null>) => string;
  // A strategy that connects a social account to a signed-in seller (lib/omni_auth/strategies).
  social?: { provider: string; label: string; flag: string; configured?: () => boolean };
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

export function stringParam(input: MutationInput, name: string): string | undefined {
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

// omniauth-google-oauth2's authorize_params over the options the strategy was configured with.
function googleAuthorizeParams(
  input: MutationInput,
  options: Record<string, string>,
  callbackUrl: string,
): Record<string, string | null> {
  const params: Record<string, string | null> = { ...options };
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
}

// Rack::Utils.escape (URI.encode_www_form_component): letters, digits and "*-._" stay, a space is a plus.
function rackEscape(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[a-zA-Z0-9*._-]/u.test(char)) return char;
      return char === " " ? "+" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// Rack::Utils.build_query keeps the insertion order; a nil value is the bare key.
function rackQuery(params: Record<string, string | null>): string {
  return Object.entries(params)
    .map(([key, value]) => (value === null ? rackEscape(key) : `${rackEscape(key)}=${rackEscape(value)}`))
    .join("&");
}

const STRATEGIES: Record<string, Strategy> = {
  google_oauth2: {
    name: "google_oauth2",
    kind: "GoogleOauth2",
    checksState: true,
    authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
    authorizeParams: (input, state, callbackUrl) =>
      googleAuthorizeParams(input, { state, scope: GOOGLE_SCOPE }, callbackUrl),
  },
  youtube: {
    name: "youtube",
    kind: "Youtube",
    checksState: true,
    authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
    social: { provider: "youtube", label: "YouTube", flag: "youtube_connect" },
    authorizeParams: (input, state, callbackUrl) =>
      googleAuthorizeParams(
        input,
        { state, scope: YOUTUBE_SCOPE, prompt: "select_account", access_type: "online" },
        callbackUrl,
      ),
  },
  instagram: {
    name: "instagram",
    kind: "Instagram",
    checksState: true,
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    social: { provider: "instagram", label: "Instagram", flag: "instagram_connect" },
    authorizeParams: (_input, state, callbackUrl) => ({
      redirect_uri: callbackUrl,
      state,
      scope: INSTAGRAM_SCOPE,
      enable_fb_login: "false",
      force_reauth: "true",
      response_type: "code",
      client_id: getConfig("INSTAGRAM_APP_ID") ?? null,
    }),
  },
  tiktok: {
    name: "tiktok",
    kind: "Tiktok",
    checksState: true,
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    social: {
      provider: "tiktok",
      label: "TikTok",
      flag: "tiktok_connect",
      configured: () => isPresent(getConfig("TIKTOK_CLIENT_KEY")),
    },
    encodeQuery: rackQuery,
    // The strategy's own request_phase: the parameters in the order it adds them, `client_id` swapped for `client_key`.
    authorizeParams: (_input, state, callbackUrl) => ({
      state,
      scope: TIKTOK_SCOPE,
      client_key: getConfig("TIKTOK_CLIENT_KEY") ?? null,
      response_type: "code",
      disable_auto_auth: TIKTOK_ALWAYS_SHOW_AUTHORIZATION,
      redirect_uri: callbackUrl,
    }),
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

// `OmniAuth.config.full_host`
export function fullHost(): string {
  const { protocol, domain } = domainConfig(process.env);
  return `${protocol}://${domain}`;
}

const requestPath = (strategy: Strategy) => `${USERS_AUTH_PATH}/${strategy.name}`;
const callbackPath = (strategy: Strategy) => `${requestPath(strategy)}/callback`;

// `request.GET`: the query string alone, flat. Rack's nested syntax and repeated names are left to Rails.
export function queryParams(url: URL): Record<string, string> {
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

export function assertHtml(input: MutationInput): void {
  if (requestFormat(input.request) !== "html") throw new HandBackToRails("a request whose format is not HTML");
}

// OmniAuth::Strategy#request_call then the strategy's request_phase. The CSRF token was checked on the way in (omniauth-rails_csrf_protection
// raises otherwise, and Rails answers that in the failure action, which Node leaves to Rails). Provider failures of this phase do not exist.
function requestPhase(strategy: Strategy) {
  return async (input: MutationInput): Promise<ActionResult> => {
    assertHtml(input);
    const { session } = input.chain;
    const { social } = strategy;
    // The request phase runs in the middleware, ahead of any controller filter: `env["warden"].user` is the session's user, and the
    // chain of this route is bare, so the visitor is resolved here. What Devise would write on the way (remember cookie, ended session)
    // is Rails' to do.
    const auth = social ? await resolveRequestAuth(input.request, input.chain.now) : null;
    if (auth && (auth.authenticatedVia === "remember_cookie" || auth.effects.signOut))
      throw new HandBackToRails("a visitor Devise signs in or out on the way");

    const params = queryParams(input.url);
    const enabled = social && auth ? await connectEnabled(strategy, auth) : true;
    // `fail!(:social_connect_unavailable)` ends in the failure action, a controller, which this bare chain is not.
    if (!enabled && isPresent(params[SOCIAL_CONNECT_RETURN]))
      throw new HandBackToRails("a disabled social connect that carries a return token");

    const state = randomBytes(STATE_BYTES).toString("hex");
    const authorize = strategy.authorizeParams(input, state, `${fullHost()}${callbackPath(strategy)}`);
    // Google takes the state from a request parameter when there is one, and stores that one.
    const sentState = authorize.state ?? state;

    const origin = stringParam(input, "origin");
    const referer = input.request.headers.get("referer");
    session.data["omniauth.params"] = params;
    // OmniAuth.config.before_request_phase
    const warden = auth?.context.loggedInUser;
    if (social && warden)
      await recordSocialConnectEvent({
        userId: warden.id,
        stage: "attempted",
        provider: social.provider,
        surface: "omniauth",
        now: () => input.chain.now,
      });
    if (origin !== undefined) session.data["omniauth.origin"] = origin;
    else if (referer !== null && !new RegExp(`${requestPath(strategy)}$`, "mu").test(referer))
      session.data["omniauth.origin"] = referer;

    // Rack::Response#redirect: no content type.
    if (!enabled) {
      const flagOff = railsLoggedInUser(auth!.context) ? SOCIAL_CONNECTIONS_PATH : LOGIN_PATH;
      return { status: FOUND, body: `Redirecting to ${flagOff}...`, contentType: "", headers: { location: flagOff } };
    }
    session.data["omniauth.state"] = sentState;
    const location = `${strategy.authorizeUrl}?${(strategy.encodeQuery ?? faradayQuery)(authorize)}`;
    return {
      status: FOUND,
      body: `Redirecting to ${location}...`,
      contentType: "",
      headers: { location },
    };
  };
}

// The strategy's `youtube_connect_enabled?` (and its Instagram and TikTok twins): the flag for the signed-in user, or the impersonated
// seller when a team member is impersonating. TikTok is also off until a client key is configured.
async function connectEnabled(strategy: Strategy, auth: ResolvedAuth): Promise<boolean> {
  const { social } = strategy;
  if (!social || (social.configured && !social.configured())) return false;
  const actor = railsLoggedInUser(auth.context);
  return isFeatureEnabled(social.flag, actor ? userActor(actor.id) : null);
}

export const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const sessionHash = (chain: Chain, key: string): Record<string, unknown> => {
  const value = chain.session.data[key];
  return isHash(value) ? value : {};
};

export const presentString = (value: unknown): value is string => typeof value === "string" && isPresent(value);

// The callback of a disabled social connect that has no return token to fail with is answered by the strategy itself, ahead of every
// controller filter: a redirect with the session cookie and nothing else.
function unavailableCallback(strategy: Strategy) {
  return async (chain: Chain): Promise<Redirected | null> => {
    if (requestFormat(chain.request) !== "html") return null;
    if (chain.auth.effects.signOut) throw new HandBackToRails("a visitor Devise signs out on the way");
    if (await connectEnabled(strategy, chain.auth)) return null;
    if (presentString(sessionHash(chain, "omniauth.params")[SOCIAL_CONNECT_RETURN])) return null;
    // A session that no page ever gave a CSRF token is written without one by the middleware; the chain would add it.
    if (typeof chain.session.data._csrf_token !== "string") throw new HandBackToRails("a session without a CSRF token");
    delete chain.session.data["omniauth.origin"];
    delete chain.session.data["omniauth.params"];
    const location = railsLoggedInUser(chain.auth.context) ? SOCIAL_CONNECTIONS_PATH : LOGIN_PATH;
    return { status: FOUND, location, middleware: `Redirecting to ${location}...` };
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

// SocialConnectReturn#consume_social_connect_return, the `before_action` of the failure action: the destination a verified return
// names. The session entry is spent whether or not it checks out.
export async function consumeSocialConnectReturn(
  chain: Chain,
  omniauthParams: Record<string, unknown>,
): Promise<string | null> {
  const stored = chain.session.data[SOCIAL_CONNECT_RETURN];
  delete chain.session.data.social_connect_return;
  const token = omniauthParams[SOCIAL_CONNECT_RETURN];
  if (!isHash(stored) || typeof token !== "string") return null;
  const { context } = chain.auth;
  const user = railsLoggedInUser(context);
  if (!user || user.id !== context.currentSeller?.id || stored.user_id !== Number(user.id)) return null;
  if (!settingsSocialConnectionsPolicy.show(await loadSellerContext(context))) return null;
  const age = typeof stored.created_at === "number" ? Math.floor(chain.now.getTime() / 1000) - stored.created_at : -1;
  if (!Number.isInteger(stored.created_at) || age < 0 || age > RETURN_LIFETIME_SECONDS) return null;
  if (typeof stored.token !== "string" || stored.token !== token) return null;
  return presentString(stored.destination) ? stored.destination : null;
}

// `value.to_s.downcase.gsub(/[^a-z0-9._-]/, "").presence&.truncate(64, omission: "")`
export function sanitizeOauthError(value: string): string | null {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "");
  return cleaned === "" ? null : cleaned.slice(0, SANITIZED_ERROR_LIMIT);
}

// User::OmniauthCallbacksController#failure for YouTube, Instagram and TikTok.
async function socialFailure(
  strategy: Strategy,
  input: MutationInput,
  type: string,
  omniauthParams: Record<string, unknown>,
): Promise<ActionResult> {
  const { chain } = input;
  const social = strategy.social!;
  const destination = await consumeSocialConnectReturn(chain, omniauthParams);
  const user = railsLoggedInUser(chain.auth.context);
  const error = stringParam(input, "error");
  if (user)
    await recordSocialConnectEvent({
      userId: user.id,
      stage: "failed",
      provider: social.provider,
      surface: "omniauth",
      extra: sanitizeOauthError(error !== undefined && isPresent(error) ? error : type),
      now: () => chain.now,
    });
  return {
    status: FOUND,
    location: user ? (destination ?? SOCIAL_CONNECTIONS_PATH) : LOGIN_PATH,
    flash: { alert: `Couldn't connect ${social.label}. Please try again.` },
  };
}

// A code the strategy exchanges is spent, so every request Rails would answer differently is handed back before the exchange: no code to
// speak of, and the options of omniauth-google-oauth2's `get_access_token` that change what it sends (an XHR, a redirect URI of its own).
async function socialConnect(
  strategy: Strategy,
  input: MutationInput,
  omniauthParams: Record<string, unknown>,
): Promise<ActionResult> {
  const { chain } = input;
  const code = stringParam(input, "code");
  if (code === undefined || !isPresent(code)) throw new HandBackToRails("a callback without a code");
  if (strategy.name === "youtube") {
    if (input.request.headers.get("x-requested-with") === "XMLHttpRequest")
      throw new HandBackToRails("an XHR callback");
    if (stringParam(input, "redirect_uri") !== undefined)
      throw new HandBackToRails("a callback that names a redirect URI");
  }
  const provider = strategy.name as SocialProvider;
  const exchanged = await exchangeCode(provider, code, `${fullHost()}${callbackPath(strategy)}`, chain.now);
  if (!exchanged.ok) return socialFailure(strategy, input, exchanged.type, omniauthParams);
  const destination = await consumeSocialConnectReturn(chain, omniauthParams);
  const user = railsLoggedInUser(chain.auth.context);
  return connectAccount(provider, {
    userId: user ? user.id : null,
    token: exchanged.token,
    uid: exchanged.uid,
    destination: destination ?? SOCIAL_CONNECTIONS_PATH,
    now: () => chain.now,
  });
}

function callbackPhase(strategy: Strategy) {
  return async (input: MutationInput): Promise<ActionResult> => {
    assertHtml(input);
    // Work on a copy: a request that is handed back must leave the session as Rails will find it.
    const chain = input.chain;
    const saved = { ...chain.session.data };
    const omniauthParams = sessionHash(chain, "omniauth.params");
    try {
      if (strategy.social) {
        // The strategy's own check comes before OAuth2's: a disabled connect with a return token fails with that token to return to.
        // (Without one, `unavailableCallback` has already answered.)
        if (!(await connectEnabled(strategy, chain.auth))) {
          delete chain.session.data["omniauth.origin"];
          delete chain.session.data["omniauth.params"];
          if (!presentString(omniauthParams[SOCIAL_CONNECT_RETURN]))
            throw new HandBackToRails("a disabled social connect the middleware should have answered");
          return await socialFailure(strategy, input, UNAVAILABLE, omniauthParams);
        }
      }
      const failed = callbackFailure(strategy, input);
      if (failed === null) {
        if (!strategy.social) throw new HandBackToRails("a callback with a code to exchange");
        return await socialConnect(strategy, input, omniauthParams);
      }
      if (strategy.social) return await socialFailure(strategy, input, failed.type, omniauthParams);
      return failure(strategy, input, failed.type, failed.reason);
    } catch (error) {
      chain.session.data = saved;
      throw error;
    }
  };
}

export const BARE: ActionOptions = { bare: true, metal: true, skip: ["redirect_to_custom_subdomain", "check_suspended"] };

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
    {
      method: "GET",
      pattern: callbackPath(strategy),
      skipForgeryProtection: true,
      ...(strategy.social ? { options: { prepended: unavailableCallback(strategy) } } : {}),
      run: callbackPhase(strategy),
    },
  ]),
);
