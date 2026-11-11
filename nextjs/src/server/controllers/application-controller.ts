// ApplicationController's filter chain for a signed-out request, plus the Rack middleware Rails wraps
// every response in, so a route handler answers with the status, headers and cookies Rails would.
//
// Covers what reaches the response: debug_headers, the CSRF token (form_authenticity_token from
// set_csrf_meta_tags, committed to the session by the session middleware), redirect_to_custom_subdomain,
// set_signup_referrer, set_gumroad_guid, set_recommender_model_name, inertia_rails' XSRF-TOKEN
// after_action and render's Vary header; then Rack::ETag, Rack::ConditionalGet, Rack::Head,
// SecureHeaders and Rack::Cors' Vary. Filters that need a signed-in user are not ported: the route
// table sends those requests to Rails (signedOutOnly). So is track_utm_link_visit: requests that can
// reach it are forwarded to Rails whole.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RequestContext } from "../auth/context.ts";
import { readEncryptedCookie, writeEncryptedCookie } from "../auth/rails-cookies.ts";
import {
  railsCookieSecrets,
  railsSessionCookieName,
  railsSessionCookieOptions,
  railsSessionExpiresAt,
} from "../auth/rails-session-config.ts";
import { railsLoggedInUser, type ResolvedAuth } from "../auth/resolve.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { getConfig, getRequiredConfig } from "../infra/config.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { railsEnv, railsRoot } from "../infra/rails-env.ts";
import { secureHeaders } from "../infra/secure-headers.ts";
import { advance } from "../models/concerns/ruby-time.ts";
import { rubyUriParse } from "../models/concerns/ruby-uri.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { formAuthenticityToken, globalCsrfToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { esJson } from "../search/es-json.ts";
import { redirectUrlFor } from "../services/subdomain-redirector.ts";

import { uncountRackAttack } from "./rack-attack.ts";
import { setCookieHeader } from "./rack-cookies.ts";
import { isPresent, queryParam, type RailsRequest, railsRequest } from "./rails-request.ts";
import {
  CURRENT_SELLER_COOKIE_NAME,
  dashboardNavRequest,
  deleteCookieHeader,
  deletesCookie,
  promoteVisitedNavItem,
  REMEMBER_COOKIE_NAME,
  requestFormat,
  resolveRequestAuth,
  seedDashboardNavItems,
  SIGN_OUT_FLASH,
  suspendedWriteRequest,
} from "./signed-in-filters.ts";

// `inertia`: rendered by inertia_rails, which appends X-Inertia to Vary. `rescued`: a before_action
// halted with it, so the after_actions (XSRF-TOKEN) did not run. `paramsRead`: the controller read
// params, so Request#should_apply_vary_header? no longer adds Vary: Accept.
// `cookies`: Set-Cookie lines the action wrote to the cookie jar. An empty `contentType` is a response with none (`head :no_content`).
export type Rendered = {
  status: number;
  body: string | Uint8Array;
  contentType: string;
  cookies?: string[];
  inertia?: boolean;
  headers?: Record<string, string>;
  rescued?: boolean;
  paramsRead?: boolean;
};
// redirect_to from the action. `rescued`: from a rescue_from handler, which skips the after_actions.
// `flash`: what the action put in flash[:alert] and friends before redirecting.
// `cookies`: the Set-Cookie lines the action wrote to the cookie jar, after the session's.
export type Redirected = {
  status: number;
  location: string;
  headers?: Record<string, string>;
  rescued?: boolean;
  flash?: Record<string, string>;
  inertiaErrors?: Record<string, unknown>;
  cookies?: string[];
  // With `prepended`: a redirect that a Rack middleware answers (OmniAuth's `redirect`), not a controller. The location goes out
  // as given; this is the body ("Redirecting to ...") and the response has no content type.
  middleware?: string;
};
// inertia_rails' middleware swapping the response for a bare 409 when the client's asset version is
// stale. The controller still ran, so its cookies (written by ActionDispatch::Cookies, outside that
// middleware) and the session survive; the headers it set do not. `rescued`: the controller halted
// or redirected, so the after_actions (XSRF-TOKEN) did not run.
export type ForceRefresh = { forceRefresh: string; rescued?: boolean };
export type ActionResult = Rendered | Redirected | ForceRefresh;

// `raise ActionController::RoutingError, "Not Found"` (ApplicationController#e404).
export class RoutingError extends Error {}

// ActionDispatch::ExceptionWrapper.rescue_responses: the exceptions Rails answers with a public error page rather than a 500.
// `save!`/`update!` raising RecordInvalid in an action is a 422.
export const exceptionStatus = (error: unknown): number =>
  error instanceof RoutingError ? 404 : error instanceof RecordInvalid ? 422 : 500;

export type BeforeAction = "redirect_to_custom_subdomain" | "check_suspended";

// The request is one Rails serves: the port cannot prove what it would answer, so the whole request
// goes to Rails instead of a guess.
export class HandBackToRails extends Error {
  constructor(message?: string) {
    super(message);
    if (process.env.HAND_BACK_DEBUG) console.error(`handed back to Rails\n${new Error().stack}`);
  }
}

export type FilterOutcome = { halt: ActionResult } | { state: Record<string, unknown> };

export type ActionOptions = {
  skip?: BeforeAction[];
  // The controller's `opt_out_of_header(:csp)`.
  optOutOfCsp?: boolean;
  // Devise's `prepend_before_action`s, which run ahead of every ApplicationController filter and so
  // before the session is checked or the host redirected. A redirect answers with the session
  // cookie only: debug_headers has not run yet.
  prepended?: (chain: Chain) => Promise<Redirected | ForceRefresh | null>;
  // The controller's own before_actions and the start of its action, after ApplicationController's.
  // `state` reaches the page's props (ActionContext.state).
  filters?: (chain: Chain) => Promise<FilterOutcome>;
  // The cookies the action's `after_action`s write (`cookies[name] = value`, e.g. DashboardPreference).
  // They run only when the chain was not halted (`rescued`), ahead of ApplicationController's own
  // after_actions (callbacks defined later run first), so they precede XSRF-TOKEN in the jar.
  afterCookies?: string[];
  // `request.session_options[:skip] = true` plus `skip_before_action :set_gumroad_guid` (RobotsController): the visitor is
  // anonymous, and the response carries no session, guid or XSRF-TOKEN cookie.
  bare?: boolean;
  // With `bare`: an ActionController::API controller. No ApplicationController filter runs and the session carries nothing but its
  // session_id, but the session middleware still answers with the session cookie.
  metal?: boolean;
  // A controller whose own `mask_token` shadows the CSRF one (AcmeChallengesController#mask_token) writes this as the
  // XSRF-TOKEN cookie instead of the masked token. The cookie value is raw bytes, written the way Rack escapes them.
  xsrfCookieBytes?: (globalToken: Buffer) => Buffer;
};

// What the session contributes to rendering an Inertia page: its CSRF token, the flash and
// inertia_errors it carries (both are consumed by the render) and two flags shared props read.
export type RenderState = {
  csrfToken: string;
  flash: Record<string, string>;
  inertiaErrors: Record<string, unknown>;
  mobileParam: unknown;
  mobileAppWebView: unknown;
  // session[:prompt_passkey_setup]: the user id LoginsController marked at sign-in.
  promptPasskeySetup: unknown;
  clearHistory: boolean;
  // The path of a dashboard page whose visit the render promotes once the props are built (Rails promotes
  // in an after_action, after the nav props are computed).
  promoteNavItemPath?: string;
  // What the controller's filters worked out for the action (FilterOutcome.state).
  pageState?: Record<string, unknown>;
  // What the Events concern reads: session[:signup_referrer] and the guid cookie this request minted.
  signupReferrer?: string;
  mintedGuid?: string;
};

export type ActionContext = {
  request: RailsRequest;
  // Who the Rails chain resolved for this request.
  context: RequestContext;
  // Reads the render state and consumes the flash and inertia_errors, as rendering the page does.
  takeRenderState: () => RenderState;
  // What the session and cookie jar hold for the Events concern, without consuming the flash (an action that renders no page
  // leaves it for the next one).
  peekState: () => Pick<RenderState, "mobileParam" | "signupReferrer" | "mintedGuid">;
  // The request's session, cookie jar and resolved auth, for the actions that sign a visitor in or out.
  chain: Chain;
};

const GUMROAD_GUID_COOKIE = "_gumroad_guid";
const XSRF_TOKEN_COOKIE = "XSRF-TOKEN";
const AUTHENTICITY_TOKEN_LENGTH = 32;
// RecommendedProductsService::MODELS
const RECOMMENDER_MODELS = ["sales"];
const UTM_REQUIRED_PARAMS = ["utm_source", "utm_medium", "utm_campaign"];
// Rack::ETag as Rails inserts it.
const ETAG_CACHE_CONTROL = "max-age=0, private, must-revalidate";
const NO_ETAG_CACHE_CONTROL = "no-cache";
const ETAG_DIGEST_LENGTH = 32;
const BROWSER_LIKE_ACCEPTS = /,\s*\*\/\*|\*\/\*\s*,/u;

// config/initializers/id_headers.rb
function debugHeaders(): Record<string, string> {
  const env = railsEnv();
  const deployed = env === "staging" || env === "production";
  return {
    "x-revision": deployed ? getRequiredEnv("REVISION") : getConfig("REVISION_DEFAULT", "no-revision"),
    "x-gr": env === "production" ? getConfig("ENV_IDENTIFIER_PROD", "PROD") : getConfig("ENV_IDENTIFIER_DEV", "DEV"),
  };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`key not found: "${name}"`);
  return value;
}

// CookieJar#handle_options for `domain: :all` without a tld_length.
export function allDomain(host: string): string | undefined {
  const labels = host.split(".");
  if (/^[\d.]+$/u.test(host) || labels.includes("") || labels.length === 1) return undefined;
  return (/\.[^.]{2,3}\.[^.]{2}$/u.test(host) ? labels.slice(-3) : labels.slice(-2)).join(".");
}

// Request::Session as the cookie store loads it: the decrypted hash, with a session_id added.
export type Session = { data: Record<string, unknown> };

function loadSession(request: RailsRequest): Session {
  const name = railsSessionCookieName();
  const raw = request.cookies.get(name) ?? undefined;
  const decoded = raw ? readEncryptedCookie(railsCookieSecrets(), name, raw) : null;
  const data =
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? { ...(decoded as Record<string, unknown>) }
      : {};
  data.session_id ??= randomBytes(16).toString("hex");
  return { data };
}

function sessionCookie(request: RailsRequest, session: Session, now: Date): string {
  const name = railsSessionCookieName();
  const expires = railsSessionExpiresAt(now);
  const options = railsSessionCookieOptions(request.host);
  return setCookieHeader(name, {
    value: writeEncryptedCookie(railsCookieSecrets(), name, session.data, { expiresAt: expires }),
    domain: options.domain,
    path: options.path,
    expires,
    secure: options.secure,
    httpOnly: options.httpOnly,
    sameSite: options.sameSite,
  });
}

// set_signup_referrer, for a signed-out visitor.
function setSignupReferrer(request: RailsRequest, session: Session, rootDomain: string): void {
  if (rubyPresent(session.data.signup_referrer)) return;
  const sref = queryParam(request, "_sref");
  const referrer = request.headers.get("referer");
  if (sref == null && referrer === null) return;

  if (isPresent(sref)) {
    session.data.signup_referrer = sref;
  } else {
    let host: string | null = null;
    try {
      host = referrer === null ? null : rubyUriParse(referrer).host;
    } catch {
      host = null;
    }
    if (isPresent(host) && !host.endsWith(rootDomain)) session.data.signup_referrer = host.toLowerCase();
  }
}

// Object#present? for a value decoded from the session's JSON.
function rubyPresent(value: unknown): boolean {
  if (typeof value === "string") return isPresent(value);
  if (value == null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// set_gumroad_guid: minted only when the request carries none.
function gumroadGuidCookie(request: RailsRequest, now: Date): string | null {
  if (request.cookies.get(GUMROAD_GUID_COOKIE) != null) return null;
  return setCookieHeader(GUMROAD_GUID_COOKIE, {
    value: crypto.randomUUID(),
    domain: allDomain(request.host),
    path: "/",
    expires: advance(now, { years: 10 }),
    httpOnly: true,
    sameSite: "lax",
  });
}

// track_utm_link_visit only records on seller hosts with all three UTM params; such requests are
// served by Rails.
function mayTrackUtmVisit(request: RailsRequest, validRequestHosts: string[]): boolean {
  if (request.method !== "GET") return false;
  if (!UTM_REQUIRED_PARAMS.every((name) => isPresent(queryParam(request, name)))) return false;
  return !validRequestHosts.includes(request.host);
}

// Request#should_apply_vary_header? for a path without a format extension.
function shouldApplyVaryHeader(request: RailsRequest): boolean {
  if (queryParam(request, "format") != null) return false;
  const accept = request.headers.get("accept");
  const xhr = request.headers.get("x-requested-with") === "XMLHttpRequest";
  if (xhr && (isPresent(accept) || request.headers.has("content-type"))) return true;
  return isPresent(accept) && !BROWSER_LIKE_ACCEPTS.test(accept);
}

// ActionController::Redirecting#_compute_redirect_to_location for a String location. Path-relative
// locations raise under load_defaults 8.1 (action_on_path_relative_redirect = :raise).
export function redirectLocation(request: RailsRequest, location: string): string {
  let url: string;
  if (/^([a-z][a-z\d\-+.]*:|\/\/)/iu.test(location)) url = location;
  else {
    if (location !== "" && !location.startsWith("/") && !location.startsWith("?")) {
      throw new Error(`Path relative URL redirect detected: ${JSON.stringify(location)}`);
    }
    url = request.protocol + request.hostWithPort + location;
  }
  return url.replace(/[\0\r\n]/gu, "");
}

type ControllerResponse = { status: number; headers: Headers; body: string | Uint8Array };

export type Chain = {
  request: RailsRequest;
  now: Date;
  headers: Headers;
  session: Session;
  csrfToken: string;
  guid: string | null;
  auth: ResolvedAuth;
  // Set-Cookie lines the cookie jar writes outside the controller's response (Devise and
  // verify_current_seller deleting cookies), which survive a response swapped by inertia_rails.
  cookies: string[];
  // sign_out cleared the session, so the CSRF token it held is gone.
  sessionCleared: boolean;
  pageState: Record<string, unknown>;
  afterCookies: string[];
  bare?: boolean;
  metal?: boolean;
  xsrfCookieBytes?: (globalToken: Buffer) => Buffer;
};

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringEntries = (value: unknown): Record<string, string> =>
  isHash(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : {};

// Rendering an Inertia page reads session["flash"] (every key is marked for discard when it loads,
// so commit_flash writes it back as nil) and session[:inertia_errors], which InertiaRails::Middleware
// deletes after a response that is neither a redirect nor a stale GET.
export function takeRenderState(chain: Chain): RenderState {
  const { data } = chain.session;
  const flash = isHash(data.flash) ? stringEntries(data.flash.flashes) : {};
  const state: RenderState = {
    csrfToken: chain.csrfToken,
    flash,
    inertiaErrors: isHash(data.inertia_errors) ? data.inertia_errors : {},
    mobileParam: data.mobile_param,
    mobileAppWebView: data.mobile_app_web_view,
    promptPasskeySetup: data.prompt_passkey_setup,
    clearHistory: data.inertia_clear_history === true,
    pageState: chain.pageState,
    ...(typeof data.signup_referrer === "string" ? { signupReferrer: data.signup_referrer } : {}),
    ...(chain.guid ? { mintedGuid: /^_gumroad_guid=([^;]+)/u.exec(chain.guid)?.[1] } : {}),
  };
  if ("flash" in data) data.flash = null;
  delete data.inertia_errors;
  delete data.inertia_clear_history;
  return state;
}

function peekState(chain: Chain): Pick<RenderState, "mobileParam" | "signupReferrer" | "mintedGuid"> {
  const { data } = chain.session;
  return {
    mobileParam: data.mobile_param,
    ...(typeof data.signup_referrer === "string" ? { signupReferrer: data.signup_referrer } : {}),
    ...(chain.guid ? { mintedGuid: /^_gumroad_guid=([^;]+)/u.exec(chain.guid)?.[1] } : {}),
  };
}

// The filters ApplicationController runs before the action. Returns the response when one of them
// halts the chain (redirect_to_custom_subdomain).
export async function beforeActions(
  request: RailsRequest,
  options: ActionOptions,
  now: Date,
): Promise<Chain | ControllerResponse> {
  const config = domainConfig(process.env);
  const headers = new Headers(debugHeaders());
  const session = loadSession(request);
  // set_csrf_meta_tags: form_authenticity_token reads the session's token or mints one.
  const csrfToken =
    typeof session.data._csrf_token === "string"
      ? session.data._csrf_token
      : randomBytes(AUTHENTICITY_TOKEN_LENGTH).toString("base64url");
  const auth: ResolvedAuth = options.bare
    ? {
        context: { loggedInUser: null, currentSeller: null, impersonatedUser: null },
        effects: { signOut: false, signedOut: null, clearCurrentSeller: false },
        authenticatedVia: null,
      }
    : await resolveRequestAuth(request, now);
  // Devise's rememberable strategy signs the visitor in by writing the session and the tracked
  // sign-in fields, which is Rails' to do: the proxy sends such requests there.
  if (auth.authenticatedVia === "remember_cookie") throw new NotPortedError("Devise's remember-cookie sign-in");
  const chain: Chain = {
    request,
    now,
    headers,
    session,
    csrfToken,
    guid: null,
    auth,
    cookies: [],
    sessionCleared: false,
    pageState: {},
    afterCookies: options.afterCookies ?? [],
    bare: options.bare ?? false,
    metal: options.metal ?? false,
    xsrfCookieBytes: options.xsrfCookieBytes,
  };

  if (options.prepended) {
    const redirect = await options.prepended(chain);
    if (redirect)
      return "forceRefresh" in redirect ? afterActions(chain, redirect) : haltWithoutDebugHeaders(chain, redirect);
  }

  // verify_current_seller, then seed_dashboard_nav_items.
  if (auth.effects.clearCurrentSeller)
    chain.cookies.push(deleteCookieHeader(CURRENT_SELLER_COOKIE_NAME, { domain: allDomain(request.host) }));
  // A session about to be ended still sees these filters first.
  const { loggedInUser, currentSeller, impersonatedUser } = auth.effects.signedOut
    ? {
        loggedInUser: auth.effects.signedOut.user,
        currentSeller: auth.effects.signedOut.seller,
        impersonatedUser: auth.effects.signedOut.impersonating ? auth.effects.signedOut.user : null,
      }
    : auth.context;
  if (
    loggedInUser &&
    currentSeller &&
    dashboardNavRequest(request, config.validRequestHosts, impersonatedUser !== null)
  ) {
    await seedDashboardNavItems(loggedInUser, currentSeller);
  }

  if (auth.effects.signOut) {
    await signOut(chain);
    if (config.validRequestHosts.includes(request.host)) return signedOutResponse(chain);
    chain.csrfToken = randomBytes(AUTHENTICITY_TOKEN_LENGTH).toString("base64url");
    chain.sessionCleared = false;
  }

  if (!options.skip?.includes("redirect_to_custom_subdomain")) {
    const redirect = await redirectUrlFor(request);
    if (redirect !== undefined) {
      headers.set("location", redirectLocation(request, redirect));
      headers.set("content-type", "text/html; charset=utf-8");
      commitSession(chain);
      for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
      return { status: 302, headers, body: "" };
    }
  }

  if (!railsLoggedInUser(auth.context) && !options.bare) setSignupReferrer(request, session, config.rootDomain);
  if (!options.skip?.includes("check_suspended") && suspendedWriteRequest(auth, request))
    return refuseSuspendedWrite(chain);
  if (!options.bare) chain.guid = gumroadGuidCookie(request, now);
  if (!options.metal && !RECOMMENDER_MODELS.includes(session.data.recommender_model_name as string)) {
    session.data.recommender_model_name = RECOMMENDER_MODELS[Math.floor(Math.random() * RECOMMENDER_MODELS.length)];
  }
  if (options.filters) {
    const outcome = await options.filters(chain);
    if ("halt" in outcome) return afterActions(chain, outcome.halt);
    chain.pageState = outcome.state;
  }
  return chain;
}

// A redirect from a filter that runs before debug_headers: the session cookie and nothing else.
function haltWithoutDebugHeaders(chain: Chain, redirect: Redirected): ControllerResponse {
  const headers = new Headers(
    redirect.middleware === undefined
      ? { location: redirectLocation(chain.request, redirect.location), "content-type": "text/html; charset=utf-8" }
      : { location: redirect.location },
  );
  commitSession({ ...chain, headers });
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  return { status: redirect.status, headers, body: redirect.middleware ?? "" };
}

// invalidate_session_if_necessary's Devise sign_out: forget_me!, the remember cookie, the session.
export async function signOut(chain: Chain): Promise<void> {
  const { request, session } = chain;
  await prismaAuthStore.forgetRememberedLogins(chain.auth.effects.signedOut!.user.id, chain.now);
  if (deletesCookie(request, REMEMBER_COOKIE_NAME))
    chain.cookies.push(deleteCookieHeader(REMEMBER_COOKIE_NAME, { domain: allDomain(request.host), httpOnly: true }));
  session.data = { session_id: session.data.session_id };
  chain.sessionCleared = true;
}

// On the app's hosts the signed-out visitor gets a flash and a redirect to the login page. Other hosts
// (the API's, a seller's) carry on signed out: their cleared session mints a new CSRF token.
function signedOutResponse(chain: Chain): ControllerResponse {
  const { request, headers, session } = chain;
  session.data.flash = { discard: [], flashes: { warning: SIGN_OUT_FLASH } };
  headers.set("location", redirectLocation(request, "/login"));
  headers.set("content-type", "text/html; charset=utf-8");
  commitSession(chain);
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  return { status: 302, headers, body: "" };
}

const SUSPENDED_MESSAGE = "You can't perform this action because your account has been suspended.";

// redirect_back's referrer: kept only when its host is the request's (raise_on_open_redirects makes
// allow_other_host false), or it is a path on this host; ActionController::Redirecting#_url_host_allowed?
export function allowedReferrer(request: RailsRequest): string | null {
  const referrer = request.headers.get("referer");
  if (referrer === null) return null;
  try {
    const host = rubyUriParse(referrer).host;
    if (host === request.host) return referrer;
    if (host != null && host !== "") return null;
    return referrer.startsWith("/") && !referrer.startsWith("//") ? referrer : null;
  } catch {
    return null;
  }
}

// check_suspended halts the chain: after_actions do not run (no XSRF-TOKEN cookie) and no guid is minted.
function refuseSuspendedWrite(chain: Chain): ControllerResponse {
  const { request, headers, session } = chain;
  const format = requestFormat(request);
  let response: ControllerResponse;
  if (format === "other") {
    // head :ok names no content type of its own.
    headers.set("content-type", "text/html");
    response = { status: 200, headers, body: "" };
  } else if (format === "json") {
    headers.set("content-type", "application/json; charset=utf-8");
    // render json: sets Vary: Accept the way any response that never read params does.
    if (shouldApplyVaryHeader(request)) headers.set("vary", "Accept");
    response = { status: 200, headers, body: esJson({ success: false, error_message: SUSPENDED_MESSAGE }) };
  } else {
    session.data.flash = { discard: [], flashes: { warning: SUSPENDED_MESSAGE } };
    headers.set("location", redirectLocation(request, allowedReferrer(request) ?? "/"));
    headers.set("content-type", "text/html; charset=utf-8");
    // InertiaRails::Middleware: a redirect after PUT, PATCH or DELETE must be followed with GET.
    const inertiaRedirect =
      request.headers.get("x-inertia") !== null && ["PUT", "PATCH", "DELETE"].includes(request.method);
    response = { status: inertiaRedirect ? 303 : 302, headers, body: "" };
  }
  commitSession(chain);
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  return response;
}

export const halted = (outcome: Chain | ControllerResponse): outcome is ControllerResponse => !("session" in outcome);

const xsrfCookie = (chain: Chain) => {
  if (chain.xsrfCookieBytes) {
    // Rack escapes the bytes (URI.encode_www_form_component); the cookie value is not valid UTF-8, so it cannot go through setCookieHeader.
    const value = Array.from(chain.xsrfCookieBytes(globalCsrfToken(chain.csrfToken)))
      .map((byte) =>
        /[*\-._0-9A-Za-z]/u.test(String.fromCharCode(byte))
          ? String.fromCharCode(byte)
          : byte === 0x20
            ? "+"
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
    return `${XSRF_TOKEN_COOKIE}=${value}; path=/; samesite=lax`;
  }
  return setCookieHeader(XSRF_TOKEN_COOKIE, {
    value: formAuthenticityToken(chain.csrfToken),
    path: "/",
    sameSite: "lax",
  });
};

function commitSession({ request, headers, session, csrfToken, now, sessionCleared, bare, metal }: Chain): void {
  if (bare && !metal) return;
  if (!sessionCleared && !bare) session.data._csrf_token = csrfToken;
  headers.append("set-cookie", sessionCookie(request, session, now));
}

// The action's result, then the after_actions and the session commit.
export function afterActions(chain: Chain, result: ActionResult): ControllerResponse {
  const { request, headers } = chain;
  if ("forceRefresh" in result) {
    const replaced = new Headers({ "x-inertia-location": result.forceRefresh });
    if (chain.guid) replaced.append("set-cookie", chain.guid);
    if (!result.rescued) {
      for (const cookie of chain.afterCookies) replaced.append("set-cookie", cookie);
      replaced.append("set-cookie", xsrfCookie(chain));
    }
    commitSession({ ...chain, headers: replaced });
    for (const cookie of chain.cookies) replaced.append("set-cookie", cookie);
    return { status: 409, headers: replaced, body: "" };
  }
  if ("location" in result) {
    if (result.flash) chain.session.data.flash = { discard: [], flashes: result.flash };
    // `redirect_to ..., inertia: { errors: }`; InertiaRails::Middleware drops errors left in the session after any other status.
    if (result.inertiaErrors) chain.session.data.inertia_errors = result.inertiaErrors;
    else if (result.status !== 301 && result.status !== 302) {
      delete chain.session.data.inertia_errors;
      delete chain.session.data.inertia_clear_history;
    }
    headers.set("location", redirectLocation(request, result.location));
    headers.set("content-type", "text/html; charset=utf-8");
    for (const [name, value] of Object.entries(result.headers ?? {})) headers.set(name, value);
  } else {
    if (result.contentType !== "") headers.set("content-type", result.contentType);
    for (const [name, value] of Object.entries(result.headers ?? {})) headers.set(name, value);
    // Vary: Accept is only added while the request's params were never read (Request#should_apply_vary_header?),
    // and an Inertia action always reads params[:slug] or the filters' query params.
    const vary = [
      !result.inertia && !result.paramsRead && shouldApplyVaryHeader(request) ? "Accept" : null,
      result.inertia ? "X-Inertia" : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (vary) headers.set("vary", vary);
  }
  if (chain.guid) headers.append("set-cookie", chain.guid);
  if (!("location" in result)) for (const cookie of result.cookies ?? []) headers.append("set-cookie", cookie);
  if (!result.rescued) {
    for (const cookie of chain.afterCookies) headers.append("set-cookie", cookie);
    if (!chain.bare) headers.append("set-cookie", xsrfCookie(chain));
  }
  commitSession(chain);
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  for (const cookie of ("cookies" in result ? result.cookies : undefined) ?? []) headers.append("set-cookie", cookie);
  // InertiaRails::Middleware: a redirect after PUT, PATCH or DELETE must be followed with GET.
  const inertiaRedirect =
    "location" in result &&
    request.headers.get("x-inertia") !== null &&
    ["PUT", "PATCH", "DELETE"].includes(request.method) &&
    [301, 302].includes(result.status);
  return { status: inertiaRedirect ? 303 : result.status, headers, body: "location" in result ? "" : result.body };
}

// PromotesDashboardNavItems#promote_visited_nav_item
function promotesVisit({ auth, request }: Chain, status: number): boolean {
  const { loggedInUser, impersonatedUser } = auth.context;
  if (!loggedInUser || status < 200 || status > 299) return false;
  return dashboardNavRequest(request, domainConfig(process.env).validRequestHosts, impersonatedUser !== null);
}

async function promoteVisit(chain: Chain, status: number): Promise<void> {
  if (promotesVisit(chain, status)) await promoteVisitedNavItem(chain.auth.context.loggedInUser!, chain.request.path);
}

async function runChain(
  request: RailsRequest,
  options: ActionOptions,
  action: (context: ActionContext) => Promise<ActionResult>,
  now: Date,
): Promise<ControllerResponse> {
  const chain = await beforeActions(request, options, now);
  if (halted(chain)) return chain;
  const result = await action({
    request,
    context: chain.auth.context,
    takeRenderState: () => takeRenderState(chain),
    peekState: () => peekState(chain),
    chain,
  });
  const response = afterActions(chain, result);
  await promoteVisit(chain, response.status);
  return response;
}

// Rack::ETag, then Rack::ConditionalGet.
function applyEtag(request: RailsRequest, response: ControllerResponse): void {
  let digest: string | null = null;
  // Rack::ETag skips only a Cache-Control that says no-cache; an `expires_in` response is tagged too.
  if (
    (response.status === 200 || response.status === 201) &&
    !response.headers.get("cache-control")?.includes("no-cache") &&
    response.body !== ""
  ) {
    digest = createHash("sha256").update(response.body).digest("hex").slice(0, ETAG_DIGEST_LENGTH);
    response.headers.set("etag", `W/"${digest}"`);
  }
  if (!response.headers.has("cache-control"))
    response.headers.set("cache-control", digest ? ETAG_CACHE_CONTROL : NO_ETAG_CACHE_CONTROL);

  const noneMatch = request.headers.get("if-none-match");
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    response.status === 200 &&
    noneMatch !== null &&
    response.headers.get("etag") === noneMatch
  ) {
    response.status = 304;
    response.headers.delete("content-type");
    response.body = "";
  }
}

// SecureHeaders::Middleware under config/initializers/secure_headers.rb: flag cookies, then add headers.
function applySecureHeaders(request: RailsRequest, headers: Headers, options: ActionOptions = {}): void {
  const https = domainConfig(process.env).protocol === "https";
  const requestIsHttps = request.protocol === "https://";
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      const flagged = new Set(
        cookie
          .split(/[;,]\s?/u)
          .map((pair) => (pair.split("=", 1)[0] ?? "").toLowerCase())
          .filter((name) => name === "secure" || name === "httponly" || name === "samesite"),
      );
      let line = cookie;
      if (https && requestIsHttps && !flagged.has("secure")) line += "; secure";
      if (!flagged.has("httponly")) line += "; HttpOnly";
      if (!flagged.has("samesite")) line += https ? "; SameSite=None" : "; SameSite=Lax";
      headers.append("set-cookie", line);
    }
  }
  for (const [name, value] of Object.entries(secureHeaders({ optOutOfCsp: options.optOutOfCsp })))
    headers.set(name, value);
}

// Rack::Cors: the "*" resource matches every path, so Origin is always added to Vary.
function applyCorsVary(headers: Headers): void {
  const vary = headers.get("vary");
  const values = vary ? vary.split(/,\s*/u) : [];
  if (!values.includes("Origin")) values.push("Origin");
  headers.set("vary", values.join(", "));
}

// ActionDispatch::PublicExceptions for the formats an Accept header names on its own; anything
// else (including q-value lists) gets the HTML page.
const PUBLIC_EXCEPTION_MESSAGES: Record<number, string> = { 404: "Not Found", 422: "Unprocessable Content" };
function publicException(request: RailsRequest, status: number): { headers: Headers; body: string } {
  const message = PUBLIC_EXCEPTION_MESSAGES[status] ?? "Internal Server Error";
  const accept = request.headers.get("accept");
  const single =
    accept !== null && !accept.includes(",") && !BROWSER_LIKE_ACCEPTS.test(accept)
      ? accept.split(/\s*;\s*/u)[0]!.trim()
      : "";
  const formats: Record<string, [string, () => string]> = {
    json: ["application/json", () => JSON.stringify({ status, error: message })],
    xml: [
      "application/xml",
      () =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<hash>\n  <status type="integer">${status}</status>\n  <error>${message}</error>\n</hash>\n`,
    ],
    yaml: ["application/x-yaml", () => `---\n:status: ${status}\n:error: ${message}\n`],
  };
  const symbol =
    (
      {
        "application/json": "json",
        "text/x-json": "json",
        "application/jsonrequest": "json",
        "application/problem+json": "json",
      } as Record<string, string>
    )[single] ??
    ({ "application/xml": "xml", "text/xml": "xml", "application/x-xml": "xml" } as Record<string, string>)[single] ??
    ({ "application/x-yaml": "yaml", "text/yaml": "yaml" } as Record<string, string>)[single];
  // The test environment's DebugExceptions answers a 422 with an HTML page whatever the Accept header says.
  if (symbol && !(status === 422 && railsEnv() === "test")) {
    const [type, body] = formats[symbol]!;
    const headers = new Headers({ "content-type": `${type}; charset=utf-8` });
    return { headers, body: request.method === "HEAD" ? "" : body() };
  }
  const file = path.join(railsRoot(), "public", `${status}.html`);
  if (!existsSync(file)) return { headers: new Headers({ "x-cascade": "pass" }), body: "" };
  return {
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body: request.method === "HEAD" ? "" : readFileSync(file, "utf8"),
  };
}

// ActionDispatch::Routing::Redirect (routes.rb `redirect`): answered by the router, so no controller filter, session or
// guid is involved, only the Rack middleware around it.
export function rackRedirect(incoming: Request, location: string, status = 301): Response {
  const request = railsRequest(incoming);
  const response: ControllerResponse = {
    status,
    headers: new Headers({ location: redirectLocation(request, location), "content-type": "text/html; charset=utf-8" }),
    // Unlike `redirect_to`, the router's redirect has no "You are being redirected" page.
    body: "",
  };
  applyEtag(request, response);
  applySecureHeaders(request, response.headers);
  applyCorsVary(response.headers);
  // Something in the Rack stack loads the session of a request that carries one, so the cookie store writes it back (re-encrypted).
  if (request.cookies.has(railsSessionCookieName()))
    response.headers.append("set-cookie", sessionCookie(request, loadSession(request), new Date()));
  return new Response(null, { status: response.status, headers: response.headers });
}

// A response a Rack middleware ahead of the app (Rack::Attack's 429) answers: the envelope of rackRedirect, with a body.
export function rackResponse(
  incoming: Request,
  status: number,
  headers: Record<string, string>,
  body: string,
): Response {
  const request = railsRequest(incoming);
  const response: ControllerResponse = { status, headers: new Headers(headers), body };
  applyEtag(request, response);
  applySecureHeaders(request, response.headers);
  applyCorsVary(response.headers);
  if (request.cookies.has(railsSessionCookieName()))
    response.headers.append("set-cookie", sessionCookie(request, loadSession(request), new Date()));
  return new Response(request.method === "HEAD" ? null : body, { status, headers: response.headers });
}

export async function forwardToRails(request: Request): Promise<Response> {
  // Rails' Rack::Attack counts the request again, so Node's own count (rack-attack.ts) is taken back first.
  await uncountRackAttack(request);
  const source = new URL(request.url);
  const target = new URL(`${source.pathname}${source.search}`, getRequiredConfig("RAILS_ORIGIN"));
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", railsRequest(request).hostWithPort);
  headers.set("x-forwarded-proto", source.protocol.replace(":", ""));
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer();
  return fetch(target, { method: request.method, headers, body, redirect: "manual" });
}

// The CSRF token the request's session cookie holds (`session[:_csrf_token]`), before any filter has run.
export function sessionCsrfToken(request: RailsRequest): string | null {
  const token = loadSession(request).data._csrf_token;
  return typeof token === "string" ? token : null;
}

// Runs `action` the way Rails runs a controller action for this request, and returns the response
// Rails would send.
export async function processAction(
  incoming: Request,
  options: ActionOptions,
  action: (context: ActionContext) => Promise<ActionResult>,
): Promise<Response> {
  const request = railsRequest(incoming);
  if (mayTrackUtmVisit(request, domainConfig(process.env).validRequestHosts)) return forwardToRails(incoming);

  const now = new Date();
  let response: ControllerResponse;
  try {
    response = await runChain(request, options, action, now);
    applyEtag(request, response);
  } catch (error) {
    if (error instanceof HandBackToRails) return forwardToRails(incoming);
    const status = exceptionStatus(error);
    if (status === 500) notifyError(error);
    const page = publicException(request, status);
    response = { status, headers: page.headers, body: page.body };
  }
  applySecureHeaders(request, response.headers, options);
  applyCorsVary(response.headers);
  // Rack::Head
  const body = request.method === "HEAD" || response.body === "" ? null : response.body;
  return new Response(body as BodyInit | null, { status: response.status, headers: response.headers });
}

// The envelope Rails puts around an Inertia HTML response, for a page Next.js renders itself: an
// App Router page cannot set headers or cookies, so the proxy runs the same chain ahead of it
// (before_actions, after_actions, session commit, SecureHeaders, Rack::Cors) and attaches the result
// to whatever the page renders. `renderState` carries what the session gives the render (CSRF token,
// consumed flash and inertia_errors) to the page, which the proxy has already committed to the cookie.
// There is no ETag: the body is not known here, and Rails' own is a digest of a body that embeds a
// fresh authenticity_token and csp_nonce, so it never matched a second request either.
export type PageEnvelope = { response: Response } | { headers: Headers; renderState: RenderState };

export async function pageEnvelope(incoming: Request, options: ActionOptions = {}): Promise<PageEnvelope> {
  const request = railsRequest(incoming);
  if (mayTrackUtmVisit(request, domainConfig(process.env).validRequestHosts))
    return { response: await forwardToRails(incoming) };

  const wrap = (headers: Headers, status: number, body: string | null) => {
    applySecureHeaders(request, headers, options);
    applyCorsVary(headers);
    return { response: new Response(request.method === "HEAD" ? null : body, { status, headers }) };
  };
  try {
    const chain = await beforeActions(request, options, new Date());
    if (halted(chain)) return wrap(chain.headers, chain.status, null);
    const renderState = takeRenderState(chain);
    const { headers } = afterActions(chain, {
      status: 200,
      body: "",
      contentType: "text/html; charset=utf-8",
      inertia: true,
    });
    // The page renders after this and builds the nav props from the rows as they are now; it promotes the visit then.
    if (promotesVisit(chain, 200)) renderState.promoteNavItemPath = chain.request.path;
    applySecureHeaders(request, headers, options);
    applyCorsVary(headers);
    return { headers, renderState };
  } catch (error) {
    if (error instanceof HandBackToRails) return { response: await forwardToRails(incoming) };
    const status = exceptionStatus(error);
    if (status === 500) notifyError(error);
    const page = publicException(request, status);
    return wrap(page.headers, status, page.body === "" ? null : page.body);
  }
}
