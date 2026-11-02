// The routes of Api::Internal::Admin::*: every one is served at /internal/admin/... on the API host and /api/internal/admin/... on the
// Gumroad host (api_routes is drawn twice). GETs reach `dispatchAdmin` through the `internal_admin` public handler and the writes
// through registerMutations (see ./index.ts); both authenticate the bearer token here, so a handler only sees an authenticated request.
import type { Rendered } from "../application-controller.ts";
import type { Params } from "../rails-body.ts";
import type { RailsRequest } from "../rails-request.ts";
import { ADMIN_SCOPE, authenticateAdmin, type AdminRequest, recordTokenUse } from "./base.ts";

export type AdminRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // "/internal/admin/purchases/:id"
  pattern: string;
  // The token scope the controller's `required_token_scope` accepts.
  scope?: string;
  // `skip_before_action :authorize_admin_token!` (auth#exchange).
  unauthenticated?: boolean;
  // `record_admin_token_use?`: false when the request must write nothing.
  recordsUse?: (params: Params) => boolean;
  run(admin: AdminRequest): Promise<Rendered>;
};

export const ADMIN_ROUTES: AdminRoute[] = [];

export const defineAdminRoute = (...routes: AdminRoute[]): void => {
  for (const route of routes) if (!ADMIN_ROUTES.some((known) => known.method === route.method && known.pattern === route.pattern)) ADMIN_ROUTES.push(route);
};

const API_PREFIX = /^\/api(?=\/internal\/admin\/)/u;

// Rails' segment excludes "." (the format separator), so `/purchases/1.json` is the format, not an id.
function match(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/.?]+)";
    })
    .join("/");
  const found = new RegExp(`^${source}$`, "u").exec(path);
  return found === null ? null : Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1]!)]));
}

export function findAdminRoute(method: string, path: string): { route: AdminRoute; routeParams: Record<string, string> } | null {
  const bare = path.replace(API_PREFIX, "");
  for (const route of ADMIN_ROUTES) {
    if (route.method !== method) continue;
    const routeParams = match(route.pattern, bare);
    if (routeParams !== null) return { route, routeParams };
  }
  return null;
}

export type AdminInput = { request: RailsRequest; url: URL; params: Params; bodyParams: Params; contentType: string | null };

export async function dispatchAdmin(input: AdminInput): Promise<Rendered | null> {
  const found = findAdminRoute(input.request.method, input.request.path);
  if (found === null) return null;
  const { route, routeParams } = found;
  const params: Params = { ...input.params, ...routeParams };
  const base = { request: input.request, url: input.url, params, bodyParams: input.bodyParams, routeParams, contentType: input.contentType };
  if (route.unauthenticated) return route.run({ ...base, admin: undefined as never });
  const outcome = await authenticateAdmin(input.request, route.scope ?? ADMIN_SCOPE);
  if ("refusal" in outcome) return { ...outcome.refusal, rescued: true };
  if (route.recordsUse === undefined || route.recordsUse(params)) await recordTokenUse(outcome.token);
  return route.run({ ...base, admin: { actor: outcome.actor, token: outcome.token } });
}
