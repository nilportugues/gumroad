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
import { railsLoggedInUser, type ResolvedAuth } from "../auth/resolve.ts";
import { prismaAuthStore } from "../auth/store.ts";
import {
  railsCookieSecrets,
  railsSessionCookieName,
  railsSessionCookieOptions,
  railsSessionExpiresAt,
} from "../auth/rails-session-config.ts";
import { getConfig, getRequiredConfig } from "../infra/config.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { railsEnv, railsRoot } from "../infra/rails-env.ts";
import { secureHeaders } from "../infra/secure-headers.ts";
import { formAuthenticityToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { rubyUriParse } from "../models/concerns/ruby-uri.ts";
import { advance } from "../models/concerns/ruby-time.ts";
import { redirectUrlFor } from "../services/subdomain-redirector.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { setCookieHeader } from "./rack-cookies.ts";
import {
  CURRENT_SELLER_COOKIE_NAME,
  dashboardNavRequest,
  deleteCookieHeader,
  deletesCookie,
  promoteVisitedNavItem,
  REMEMBER_COOKIE_NAME,
  refuseSuspendedWrite,
  resolveRequestAuth,
  seedDashboardNavItems,
  SIGN_OUT_FLASH,
  suspendedWriteRequest,
} from "./signed-in-filters.ts";
import { isPresent, queryParam, type RailsRequest, railsRequest } from "./rails-request.ts";

// `inertia`: rendered by inertia_rails, which appends X-Inertia to Vary.
export type Rendered = { status: number; body: string; contentType: string; inertia?: boolean; headers?: Record<string, string> };
// redirect_to from the action. `rescued`: from a rescue_from handler, which skips the after_actions.
// `flash`: what the action put in flash[:alert] and friends before redirecting.
export type Redirected = { status: number; location: string; rescued?: boolean; flash?: Record<string, string> };
// inertia_rails' middleware swapping the response for a bare 409 when the client's asset version is
// stale. The controller still ran, so its cookies (written by ActionDispatch::Cookies, outside that
// middleware) and the session survive; the headers it set do not. `rescued`: the controller halted
// or redirected, so the after_actions (XSRF-TOKEN) did not run.
export type ForceRefresh = { forceRefresh: string; rescued?: boolean };
export type ActionResult = Rendered | Redirected | ForceRefresh;

// `raise ActionController::RoutingError, "Not Found"` (ApplicationController#e404).
export class RoutingError extends Error {}

export type BeforeAction = "redirect_to_custom_subdomain";

export type ActionOptions = { skip?: BeforeAction[] };

// What the session contributes to rendering an Inertia page: its CSRF token, the flash and
// inertia_errors it carries (both are consumed by the render) and two flags shared props read.
export type RenderState = {
  csrfToken: string;
  flash: Record<string, string>;
  inertiaErrors: Record<string, string>;
  mobileParam: unknown;
  mobileAppWebView: unknown;
  // session[:prompt_passkey_setup]: the user id LoginsController marked at sign-in.
  promptPasskeySetup: unknown;
  clearHistory: boolean;
};

export type ActionContext = {
  request: RailsRequest;
  // Who the Rails chain resolved for this request.
  context: RequestContext;
  // Reads the render state and consumes the flash and inertia_errors, as rendering the page does.
  takeRenderState: () => RenderState;
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
const BROWSER_LIKE_ACCEPTS = /,\s*\*\/\*|\*\/\*\s*,/;

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
  if (/^[\d.]+$/.test(host) || labels.includes("") || labels.length === 1) return undefined;
  return (/\.[^.]{2,3}\.[^.]{2}$/.test(host) ? labels.slice(-3) : labels.slice(-2)).join(".");
}

// Request::Session as the cookie store loads it: the decrypted hash, with a session_id added.
export type Session = { data: Record<string, unknown> };

function loadSession(request: RailsRequest): Session {
  const name = railsSessionCookieName();
  const raw = request.cookies.get(name) ?? undefined;
  const decoded = raw ? readEncryptedCookie(railsCookieSecrets(), name, raw) : null;
  const data = decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? { ...(decoded as Record<string, unknown>) } : {};
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
  const accept = request.headers.get("accept");
  const xhr = request.headers.get("x-requested-with") === "XMLHttpRequest";
  if (xhr && (isPresent(accept) || request.headers.has("content-type"))) return true;
  return isPresent(accept) && !BROWSER_LIKE_ACCEPTS.test(accept);
}

// ActionController::Redirecting#_compute_redirect_to_location for a String location. Path-relative
// locations raise under load_defaults 8.1 (action_on_path_relative_redirect = :raise).
export function redirectLocation(request: RailsRequest, location: string): string {
  let url: string;
  if (/^([a-z][a-z\d\-+.]*:|\/\/)/i.test(location)) url = location;
  else {
    if (location !== "" && !location.startsWith("/") && !location.startsWith("?")) {
      throw new Error(`Path relative URL redirect detected: ${JSON.stringify(location)}`);
    }
    url = request.protocol + request.hostWithPort + location;
  }
  return url.replace(/[\0\r\n]/g, "");
}

type ControllerResponse = { status: number; headers: Headers; body: string };

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
};

const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const stringEntries = (value: unknown): Record<string, string> =>
  isHash(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

// Rendering an Inertia page reads session["flash"] (every key is marked for discard when it loads,
// so commit_flash writes it back as nil) and session[:inertia_errors], which InertiaRails::Middleware
// deletes after a response that is neither a redirect nor a stale GET.
export function takeRenderState(chain: Chain): RenderState {
  const { data } = chain.session;
  const flash = isHash(data.flash) ? stringEntries(data.flash.flashes) : {};
  const state: RenderState = {
    csrfToken: chain.csrfToken,
    flash,
    inertiaErrors: stringEntries(data.inertia_errors),
    mobileParam: data.mobile_param,
    mobileAppWebView: data.mobile_app_web_view,
    promptPasskeySetup: data.prompt_passkey_setup,
    clearHistory: data.inertia_clear_history === true,
  };
  if ("flash" in data) data.flash = null;
  delete data.inertia_errors;
  delete data.inertia_clear_history;
  return state;
}

// The filters ApplicationController runs before the action. Returns the response when one of them
// halts the chain (redirect_to_custom_subdomain).
export async function beforeActions(request: RailsRequest, options: ActionOptions, now: Date): Promise<Chain | ControllerResponse> {
  const config = domainConfig(process.env);
  const headers = new Headers(debugHeaders());
  const session = loadSession(request);
  // set_csrf_meta_tags: form_authenticity_token reads the session's token or mints one.
  const csrfToken =
    typeof session.data._csrf_token === "string" ? session.data._csrf_token : randomBytes(AUTHENTICITY_TOKEN_LENGTH).toString("base64url");
  const auth = await resolveRequestAuth(request, now);
  // Devise's rememberable strategy signs the visitor in by writing the session and the tracked
  // sign-in fields, which is Rails' to do: the proxy sends such requests there.
  if (auth.authenticatedVia === "remember_cookie") throw new NotPortedError("Devise's remember-cookie sign-in");
  const chain: Chain = { request, now, headers, session, csrfToken, guid: null, auth, cookies: [], sessionCleared: false };

  // verify_current_seller, then seed_dashboard_nav_items.
  if (auth.effects.clearCurrentSeller) chain.cookies.push(deleteCookieHeader(CURRENT_SELLER_COOKIE_NAME, { domain: allDomain(request.host) }));
  // A session about to be ended still sees these filters first.
  const { loggedInUser, currentSeller, impersonatedUser } = auth.effects.signedOut
    ? { loggedInUser: auth.effects.signedOut.user, currentSeller: auth.effects.signedOut.seller, impersonatedUser: auth.effects.signedOut.impersonating ? auth.effects.signedOut.user : null }
    : auth.context;
  if (loggedInUser && currentSeller && dashboardNavRequest(request, config.validRequestHosts, impersonatedUser !== null)) {
    await seedDashboardNavItems(loggedInUser, currentSeller);
  }

  if (auth.effects.signOut) return endSession(chain, config.validRequestHosts);

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

  if (!railsLoggedInUser(auth.context)) setSignupReferrer(request, session, config.rootDomain);
  if (suspendedWriteRequest(auth, request)) refuseSuspendedWrite();
  chain.guid = gumroadGuidCookie(request, now);
  if (!RECOMMENDER_MODELS.includes(session.data.recommender_model_name as string)) {
    session.data.recommender_model_name = RECOMMENDER_MODELS[Math.floor(Math.random() * RECOMMENDER_MODELS.length)];
  }
  return chain;
}

// invalidate_session_if_necessary: Devise's sign_out (forget_me!, the remember cookie, the session),
// then a flash and a redirect to the login page. Other hosts carry on signed out; not ported.
async function endSession(chain: Chain, validRequestHosts: string[]): Promise<ControllerResponse> {
  const { request, headers, session, now } = chain;
  if (!validRequestHosts.includes(request.host)) throw new NotPortedError("invalidate_session_if_necessary outside the app hosts");
  await prismaAuthStore.forgetRememberedLogins(chain.auth.effects.signedOut!.user.id, now);
  if (deletesCookie(request, REMEMBER_COOKIE_NAME)) chain.cookies.push(deleteCookieHeader(REMEMBER_COOKIE_NAME, { domain: allDomain(request.host), httpOnly: true }));
  session.data = { session_id: session.data.session_id, flash: { discard: [], flashes: { warning: SIGN_OUT_FLASH } } };
  chain.sessionCleared = true;
  headers.set("location", redirectLocation(request, "/login"));
  headers.set("content-type", "text/html; charset=utf-8");
  commitSession(chain);
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  return { status: 302, headers, body: "" };
}

export const halted = (outcome: Chain | ControllerResponse): outcome is ControllerResponse => !("session" in outcome);

const xsrfCookie = (chain: Chain) => setCookieHeader(XSRF_TOKEN_COOKIE, { value: formAuthenticityToken(chain.csrfToken), path: "/", sameSite: "lax" });

function commitSession({ request, headers, session, csrfToken, now, sessionCleared }: Chain): void {
  if (!sessionCleared) session.data._csrf_token = csrfToken;
  headers.append("set-cookie", sessionCookie(request, session, now));
}

// The action's result, then the after_actions and the session commit.
export function afterActions(chain: Chain, result: ActionResult): ControllerResponse {
  const { request, headers } = chain;
  if ("forceRefresh" in result) {
    const replaced = new Headers({ "x-inertia-location": result.forceRefresh });
    if (chain.guid) replaced.append("set-cookie", chain.guid);
    if (!result.rescued) replaced.append("set-cookie", xsrfCookie(chain));
    commitSession({ ...chain, headers: replaced });
    for (const cookie of chain.cookies) replaced.append("set-cookie", cookie);
    return { status: 409, headers: replaced, body: "" };
  }
  if ("location" in result) {
    if (result.flash) chain.session.data.flash = { discard: [], flashes: result.flash };
    headers.set("location", redirectLocation(request, result.location));
    headers.set("content-type", "text/html; charset=utf-8");
  } else {
    headers.set("content-type", result.contentType);
    for (const [name, value] of Object.entries(result.headers ?? {})) headers.set(name, value);
    // Vary: Accept is only added while the request's params were never read (Request#should_apply_vary_header?),
    // and an Inertia action always reads params[:slug] or the filters' query params.
    const vary = [!result.inertia && shouldApplyVaryHeader(request) ? "Accept" : null, result.inertia ? "X-Inertia" : null]
      .filter(Boolean)
      .join(", ");
    if (vary) headers.set("vary", vary);
  }
  if (chain.guid) headers.append("set-cookie", chain.guid);
  if (!("location" in result && result.rescued)) {
    headers.append("set-cookie", xsrfCookie(chain));
  }
  commitSession(chain);
  for (const cookie of chain.cookies) headers.append("set-cookie", cookie);
  return { status: result.status, headers, body: "location" in result ? "" : result.body };
}

// PromotesDashboardNavItems#promote_visited_nav_item
async function promoteVisit({ auth, request }: Chain, status: number): Promise<void> {
  const { loggedInUser, impersonatedUser } = auth.context;
  if (!loggedInUser || status < 200 || status > 299) return;
  if (!dashboardNavRequest(request, domainConfig(process.env).validRequestHosts, impersonatedUser !== null)) return;
  await promoteVisitedNavItem(loggedInUser, request.path);
}

async function runChain(
  request: RailsRequest,
  options: ActionOptions,
  action: (context: ActionContext) => Promise<ActionResult>,
  now: Date,
): Promise<ControllerResponse> {
  const chain = await beforeActions(request, options, now);
  if (halted(chain)) return chain;
  const result = await action({ request, context: chain.auth.context, takeRenderState: () => takeRenderState(chain) });
  const response = afterActions(chain, result);
  await promoteVisit(chain, response.status);
  return response;
}

// Rack::ETag, then Rack::ConditionalGet.
function applyEtag(request: RailsRequest, response: ControllerResponse): void {
  let digest: string | null = null;
  if ((response.status === 200 || response.status === 201) && !response.headers.has("cache-control") && response.body !== "") {
    digest = createHash("sha256").update(response.body).digest("hex").slice(0, ETAG_DIGEST_LENGTH);
    response.headers.set("etag", `W/"${digest}"`);
  }
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", digest ? ETAG_CACHE_CONTROL : NO_ETAG_CACHE_CONTROL);

  const noneMatch = request.headers.get("if-none-match");
  if ((request.method === "GET" || request.method === "HEAD") && response.status === 200 && noneMatch !== null && response.headers.get("etag") === noneMatch) {
    response.status = 304;
    response.headers.delete("content-type");
    response.body = "";
  }
}

// SecureHeaders::Middleware under config/initializers/secure_headers.rb: flag cookies, then add headers.
function applySecureHeaders(request: RailsRequest, headers: Headers): void {
  const https = domainConfig(process.env).protocol === "https";
  const requestIsHttps = request.protocol === "https://";
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      const flagged = new Set(
        cookie
          .split(/[;,]\s?/)
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
  for (const [name, value] of Object.entries(secureHeaders())) headers.set(name, value);
}

// Rack::Cors: the "*" resource matches every path, so Origin is always added to Vary.
function applyCorsVary(headers: Headers): void {
  const vary = headers.get("vary");
  const values = vary ? vary.split(/,\s*/) : [];
  if (!values.includes("Origin")) values.push("Origin");
  headers.set("vary", values.join(", "));
}

// ActionDispatch::PublicExceptions for the formats an Accept header names on its own; anything
// else (including q-value lists) gets the HTML page.
function publicException(request: RailsRequest, status: number): { headers: Headers; body: string } {
  const message = status === 404 ? "Not Found" : "Internal Server Error";
  const accept = request.headers.get("accept");
  const single = accept !== null && !accept.includes(",") && !BROWSER_LIKE_ACCEPTS.test(accept) ? accept.split(/\s*;\s*/)[0]!.trim() : "";
  const formats: Record<string, [string, () => string]> = {
    json: ["application/json", () => JSON.stringify({ status, error: message })],
    xml: [
      "application/xml",
      () => `<?xml version="1.0" encoding="UTF-8"?>\n<hash>\n  <status type="integer">${status}</status>\n  <error>${message}</error>\n</hash>\n`,
    ],
    yaml: ["application/x-yaml", () => `---\n:status: ${status}\n:error: ${message}\n`],
  };
  const symbol =
    ({ "application/json": "json", "text/x-json": "json", "application/jsonrequest": "json", "application/problem+json": "json" } as Record<string, string>)[single] ??
    ({ "application/xml": "xml", "text/xml": "xml", "application/x-xml": "xml" } as Record<string, string>)[single] ??
    ({ "application/x-yaml": "yaml", "text/yaml": "yaml" } as Record<string, string>)[single];
  if (symbol) {
    const [type, body] = formats[symbol]!;
    const headers = new Headers({ "content-type": `${type}; charset=utf-8` });
    return { headers, body: request.method === "HEAD" ? "" : body() };
  }
  const file = path.join(railsRoot(), "public", `${status}.html`);
  if (!existsSync(file)) return { headers: new Headers({ "x-cascade": "pass" }), body: "" };
  return { headers: new Headers({ "content-type": "text/html; charset=utf-8" }), body: request.method === "HEAD" ? "" : readFileSync(file, "utf8") };
}

async function forwardToRails(request: Request): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(`${source.pathname}${source.search}`, getRequiredConfig("RAILS_ORIGIN"));
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", railsRequest(request).hostWithPort);
  headers.set("x-forwarded-proto", source.protocol.replace(":", ""));
  return fetch(target, { method: request.method, headers, redirect: "manual" });
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
    const status = error instanceof RoutingError ? 404 : 500;
    if (status === 500) notifyError(error);
    const page = publicException(request, status);
    response = { status, headers: page.headers, body: page.body };
  }
  applySecureHeaders(request, response.headers);
  applyCorsVary(response.headers);
  // Rack::Head
  const body = request.method === "HEAD" || response.body === "" ? null : response.body;
  return new Response(body, { status: response.status, headers: response.headers });
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
  if (mayTrackUtmVisit(request, domainConfig(process.env).validRequestHosts)) return { response: await forwardToRails(incoming) };

  const wrap = (headers: Headers, status: number, body: string | null) => {
    applySecureHeaders(request, headers);
    applyCorsVary(headers);
    return { response: new Response(request.method === "HEAD" ? null : body, { status, headers }) };
  };
  try {
    const chain = await beforeActions(request, options, new Date());
    if (halted(chain)) return wrap(chain.headers, chain.status, null);
    const renderState = takeRenderState(chain);
    const { headers } = afterActions(chain, { status: 200, body: "", contentType: "text/html; charset=utf-8", inertia: true });
    await promoteVisit(chain, 200);
    applySecureHeaders(request, headers);
    applyCorsVary(headers);
    return { headers, renderState };
  } catch (error) {
    notifyError(error);
    const page = publicException(request, 500);
    return wrap(page.headers, 500, page.body === "" ? null : page.body);
  }
}
