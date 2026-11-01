// The parts of ApplicationController's filter chain that only a signed-in request runs: Devise's
// cookie effects, verify_current_seller, invalidate_session_if_necessary, check_suspended and the
// dashboard nav promotion callbacks.
import type { User } from "@prisma/client";

import { railsLoggedInUser, resolveAuth, type ResolvedAuth } from "../auth/resolve.ts";
import { railsCookieSecrets, railsSessionCookieName, CURRENT_SELLER_COOKIE_NAME, REMEMBER_COOKIE_NAME } from "../auth/rails-session-config.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { RISK_STATES } from "../models/user.ts";
import { dashboardNavItems, earnedNavItems, insertNavItems } from "../page-props/signed-in/reads.ts";
import { PROMOTABLE_NAV_ITEMS } from "../page-props/signed-in/presenters.ts";
import { setCookieHeader } from "./rack-cookies.ts";
import { type RailsRequest, isPresent, queryParam } from "./rails-request.ts";

export const SIGN_OUT_FLASH = "We're sorry; you have been logged out. Please login again.";
const SEEDED_MARKER = "seeded";
const EPOCH = new Date(0);

export function resolveRequestAuth(request: RailsRequest, now: Date): Promise<ResolvedAuth> {
  return resolveAuth({
    cookies: { get: (name) => request.cookies.get(name) ?? undefined },
    secrets: railsCookieSecrets(),
    sessionCookieName: railsSessionCookieName(),
    store: prismaAuthStore,
    now,
  });
}

// Rack's delete_set_cookie_header: an empty value that expired at the epoch.
export const deleteCookieHeader = (name: string, options: { domain?: string; httpOnly?: boolean }) =>
  setCookieHeader(name, { value: "", domain: options.domain, path: "/", maxAge: 0, expires: EPOCH, httpOnly: options.httpOnly, sameSite: "lax" });

// CookieJar#delete is a no-op when the browser sent no such cookie.
export const deletesCookie = (request: RailsRequest, name: string) => request.cookies.has(name);

export { CURRENT_SELLER_COOKIE_NAME, REMEMBER_COOKIE_NAME };

// check_suspended: `if: logged_in_user suspended, not impersonating, not GET/HEAD`.
export function suspendedWriteRequest(auth: ResolvedAuth, request: RailsRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const user = railsLoggedInUser(auth.context);
  if (!user || auth.context.impersonatedUser) return false;
  return (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(user.user_risk_state);
}

// DashboardNav
const PATH_PREFIXES: Record<string, string> = {
  "/agent": "agent",
  "/profile": "profile",
  "/pages": "pages",
  "/collaborators": "collaborators",
  "/checkout/discounts": "checkout",
  "/checkout/form": "checkout",
  "/checkout/upsells": "checkout",
  "/emails": "emails",
  "/followers": "emails",
  "/workflows": "workflows",
  "/dashboard/sales": "analytics",
  "/dashboard/audience": "analytics",
  "/dashboard/utm_links": "analytics",
  "/dashboard/churn": "analytics",
  "/affiliates": "affiliates",
  "/communities": "community",
  "/library": "library",
  "/wishlists": "library",
  "/reviews": "library",
};
const CORE_PATH_PREFIXES = ["/products", "/bundles", "/customers", "/payouts", "/settings", "/discover", "/help"];
const CORE_PATHS = ["/dashboard"];
const ORDERED_PREFIXES = Object.entries(PATH_PREFIXES).sort(([a], [b]) => b.length - a.length);

const normalizePath = (path: string) => path.replace(/\/$/, "").toLowerCase();
const pathMatches = (normalized: string, prefix: string) => normalized === prefix || normalized.startsWith(`${prefix}/`);

export function dashboardPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized === "") return false;
  if (CORE_PATHS.includes(normalized)) return true;
  return [...CORE_PATH_PREFIXES, ...Object.keys(PATH_PREFIXES)].some((prefix) => pathMatches(normalized, prefix));
}

export function navItemForPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === "") return null;
  return ORDERED_PREFIXES.find(([prefix]) => pathMatches(normalized, prefix))?.[1] ?? null;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const XML_TYPES = new Set(["text/xml", "application/xml"]);
// Mime::JSON and its synonyms
const JSON_TYPES = new Set(["application/json", "text/x-json", "application/jsonrequest"]);

export type RequestFormat = "html" | "json" | "other";

// Request#format, as far as html? and json? tell: a `format` query param wins (an unregistered one
// leaves Rails with a NullType); otherwise an Accept header names the format when it is not
// browser-like or the request is an XHR; otherwise XHR means js and the rest html. Browsers list
// xml first and xhtml after it, which Rails reads as html. A `format` in a form body is not read.
export function requestFormat(request: RailsRequest): RequestFormat {
  const param = queryParam(request, "format");
  if (param !== undefined && param !== null) return param === "html" ? "html" : param === "json" ? "json" : "other";
  const accept = request.headers.get("accept");
  const xhr = request.headers.get("x-requested-with") === "XMLHttpRequest";
  const browserLike = /,\s*\*\/\*|\*\/\*\s*,/.test(accept ?? "");
  const validAccept = (xhr && (isPresent(accept) || request.headers.has("content-type"))) || (isPresent(accept) && !browserLike);
  if (!validAccept) return xhr ? "other" : "html";
  const types = (accept ?? "")
    .split(",")
    .map((entry, index) => {
      const [type = "", ...params] = entry.split(";").map((part) => part.trim());
      const quality = params.map((param) => /^q=([\d.]+)$/.exec(param)?.[1]).find((q) => q !== undefined);
      return { type, quality: quality === undefined ? 1 : Number(quality), index };
    })
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ type }) => type);
  const [first = ""] = types;
  if (HTML_TYPES.has(first) || (XML_TYPES.has(first) && types.includes("application/xhtml+xml"))) return "html";
  return JSON_TYPES.has(first) ? "json" : "other";
}

export const formatIsHtml = (request: RailsRequest): boolean => requestFormat(request) === "html";

// PromotesDashboardNavItems#dashboard_nav_request?
export function dashboardNavRequest(request: RailsRequest, validRequestHosts: string[], impersonating: boolean): boolean {
  if (request.method !== "GET") return false;
  if (!formatIsHtml(request)) return false;
  if (isPresent(request.headers.get("x-inertia-partial-data"))) return false;
  if (request.headers.get("purpose") === "prefetch") return false;
  if (impersonating) return false;
  if (!validRequestHosts.includes(request.host)) return false;
  return dashboardPath(request.path);
}

// seed_dashboard_nav_items: only from the user's own store. Failures never fail the page.
export async function seedDashboardNavItems(user: User, seller: User): Promise<void> {
  if (user.id !== seller.id) return;
  try {
    if ((await dashboardNavItems(user.id)).includes(SEEDED_MARKER)) return;
    await insertNavItems(user.id, [...(await earnedNavItems(user, seller.id)), SEEDED_MARKER]);
  } catch (error) {
    notifyError(error);
  }
}

// promote_visited_nav_item: runs after a successful render.
export async function promoteVisitedNavItem(user: User, path: string): Promise<void> {
  try {
    const item = navItemForPath(path);
    if (item === null || !PROMOTABLE_NAV_ITEMS.includes(item)) return;
    if ((await dashboardNavItems(user.id)).includes(item)) return;
    await insertNavItems(user.id, [item]);
  } catch (error) {
    notifyError(error);
  }
}
