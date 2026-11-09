// Api::V2::BaseController and the dispatcher for the v2 API routes Node serves. The proxy rewrites a request for a route marked
// `handler: "api-v2"` in routes.json (on the API host as `/v2/...`, on the Gumroad domain as `/api/v2/...`) to /gr-public/api-v2,
// which lands in `apiV2Response`: the same chain as a page request (processAction), then the route's scopes, `before` filters and action.
//
// Whatever the port cannot prove goes to Rails whole, body included, before the action's first write: a NotPortedError, a body Node
// does not parse and any `HandBackToRails`.
import type { OauthAccessToken, User } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { db } from "../../../lib/db.ts";
import { currentApiUser, doorkeeperAuthorize, doorkeeperToken, requireOauthScope } from "../../auth/api-token.ts";
import { column, table } from "../../models/sql.ts";
import { NotPortedError, UserFlags } from "../../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../../page-props/not-ported.ts";
import { PAGE_URL_HEADER } from "../../page-props/render-state.ts";
import { forwardToRails, HandBackToRails, processAction, type ActionResult, type Rendered } from "../application-controller.ts";
import { parseNestedQuery, requestParams, type Params } from "../rails-body.ts";
import type { RailsRequest } from "../rails-request.ts";
import { escapeHtmlInJson } from "../../search/es-json.ts";

// Doorkeeper.configuration.public_api_read_scopes.concat([:view_public])
export const PUBLIC_READ_SCOPES = ["edit_products", "view_sales", "mark_sales_as_shipped", "edit_sales", "revenue_share", "ifttt", "view_profile", "view_payouts", "view_tax_data", "account", "view_public"];
export const EDIT_PRODUCTS_SCOPES = ["edit_products"];

export type ApiV2Input = {
  request: RailsRequest;
  url: URL;
  // The route's `:id`, `:link_id` and friends.
  routeParams: Record<string, string>;
  // request.parameters (query string, then body, then the route's own).
  params: Params;
  rawBody: Uint8Array;
  token: OauthAccessToken;
  // Api::V2::BaseController#current_resource_owner
  owner: User;
  // What the route's before_actions loaded (@product, @variant_category...).
  state: Record<string, any>;
};

export type ApiV2Route = {
  method: string;
  // "/v2/products/:link_id/custom_fields"; the `/api` prefix is matched as well.
  pattern: string;
  // doorkeeper_authorize!(*scopes): any one of them, with `account` always accepted.
  scopes: string[];
  // before_actions that render: a Rendered halts the request (and skips the after_action).
  before?(input: ApiV2Input): Promise<Rendered | undefined | void>;
  // WS-17c: an action with no `doorkeeper_authorize!` (token and owner are null for it), a `require_oauth_scope!` straight after the
  // authorization, a controller's own `doorkeeper_unauthorized_render_options`, `skip_before_action :verify_authenticity_token` (the
  // request keeps its session), and `prepend_before_action`s that answer ahead of the whole chain (they may throw HandBackToRails).
  anonymous?: boolean;
  requireScope?: string[];
  unauthorized?(headers: Record<string, string>): Rendered;
  keepSession?: boolean;
  // The action reads the JSON body itself (`request.raw_post`), so a body that is an array or a scalar is not a hand-back.
  rawJsonBody?: boolean;
  preAuth?(input: Pick<ApiV2Input, "request" | "url" | "params" | "rawBody">): void | Promise<void>;
  run(input: ApiV2Input): Promise<ActionResult>;
};

const REGISTRY: ApiV2Route[] = [];

export function registerApiV2(...routes: ApiV2Route[]): void {
  for (const route of routes) if (!REGISTRY.some((known) => known.method === route.method && known.pattern === route.pattern)) REGISTRY.push(route);
}

export const registeredApiV2Routes = (): readonly ApiV2Route[] => REGISTRY;

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith("*")) {
        names.push(segment.slice(1));
        return "(.+)";
      }
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/.?]+)";
    })
    .join("/");
  const match = new RegExp(`^${source}$`, "u").exec(path.replace(/^\/api\/v2\//u, "/v2/"));
  return match === null ? null : Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
}

export const json = (body: unknown, status = 200, headers?: Record<string, string>): Rendered => ({ status, body: escapeHtmlInJson(JSON.stringify(body)), contentType: "application/json; charset=utf-8", ...(headers ? { headers } : {}) });

// `render_response(success, result)`: `{ success: }.merge(result.as_json(api_scopes:))`.
export const renderResponse = (success: boolean, result: Record<string, unknown> = {}): Rendered => json({ success, ...result });

export const successWithObject = (objectType: string, object: unknown, additionalInfo: Record<string, unknown> = {}): Rendered =>
  object === null || object === undefined ? renderResponse(true, { message: `The ${objectType} was deleted successfully.` }) : renderResponse(true, { [objectType]: object, ...additionalInfo });

// `error_with_object(name, object)`: `errors` is `object.errors.full_messages.to_sentence` when the object has any.
export const errorWithObject = (objectName: string, object: { errors?: string[] } | null | undefined = null): Rendered => {
  const message = object ? (object.errors && object.errors.length > 0 ? toSentence(object.errors) : `The ${objectName} was unable to be modified.`) : `The ${objectName} was not found.`;
  return renderResponse(false, { message });
};

export const errorWithCreatingObject = (objectName: string, object: { errors: string[] } | null = null): Rendered =>
  renderResponse(false, { message: object ? toSentence(object.errors) : `The ${objectName} was unable to be created.` });

export const error400 = (output = "Invalid request."): Rendered => json({ status: 400, error: output }, 400);

// Array#to_sentence
export function toSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// ExternalId.find_by_external_id's `from_external_id`: null for anything that does not decrypt.
export const fromExternalId = (externalId: unknown): number | null => (typeof externalId === "string" ? decrypt(externalId) : null);

// Api::V2::BaseController#fetch_product: `current_resource_owner.links` (soft-deleted ones included) by external id, then permalink.
export async function fetchProduct(owner: User, id: string | undefined) {
  const decoded = fromExternalId(id);
  if (decoded !== null) {
    const byId = await db.link.findFirst({ where: { user_id: owner.id, id: decoded } });
    if (byId) return byId;
  }
  if (typeof id !== "string") return null;
  return db.link.findFirst({ where: { user_id: owner.id, unique_permalink: id } });
}

const GUMROAD_CLI_USER_AGENT = /^gumroad-cli\//iu;

// Api::V2::BaseController#log_method_use, an after_action: a request from the CLI marks the seller as a CLI user.
async function markCliUser(request: RailsRequest, owner: User): Promise<void> {
  if (!GUMROAD_CLI_USER_AGENT.test(request.headers.get("user-agent") ?? "")) return;
  if (UserFlags.isSet(owner.flags, "has_used_cli")) return;
  const mask = UserFlags.bit("has_used_cli");
  await db.$executeRaw(Prisma.sql`UPDATE ${table("users")} SET ${column("users", "flags")} = ${column("users", "flags")} | ${mask} WHERE ${column("users", "id")} = ${owner.id} AND ${column("users", "flags")} & ${mask} = 0`);
}

export async function apiV2Response(incoming: Request): Promise<Response> {
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const bytes = new Uint8Array(await incoming.arrayBuffer());
  const url = new URL(target, `${protocol}://${host}`);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: bytes.length > 0 && incoming.method !== "GET" && incoming.method !== "HEAD" ? bytes : undefined });

  const method = request.method === "HEAD" ? "GET" : request.method;
  const found = REGISTRY.map((route) => ({ route, routeParams: route.method === method ? matchPattern(route.pattern, url.pathname) : null })).find(({ routeParams }) => routeParams !== null);
  if (found === undefined) return forwardToRails(request);
  const { route, routeParams } = found;

  let params: Params;
  try {
    params = { ...(route.rawJsonBody ? rawJsonParams(url, request.headers.get("content-type"), bytes) : requestParams(url, request.headers.get("content-type"), bytes)), ...routeParams };
  } catch (error) {
    if (error instanceof HandBackToRails) return handBack(request, error);
    throw error;
  }

  // protect_from_forgery answers an unverified POST, PUT, PATCH or DELETE with a null session and cookie jar: no session, guid or
  // XSRF-TOKEN cookie. A request that carries a CSRF token might verify, which the port leaves to Rails.
  const mutating = !["GET", "HEAD"].includes(request.method);
  if (mutating && !route.keepSession && (request.headers.has("x-csrf-token") || request.headers.has("x-xsrf-token") || "authenticity_token" in params)) return handBack(request, new HandBackToRails("a write that carries a CSRF token"));

  return processAction(request, mutating && !route.keepSession ? { bare: true } : {}, async ({ request: railsReq }) => {
    try {
      await route.preAuth?.({ request: railsReq, url, params, rawBody: bytes });
      let token: OauthAccessToken | null = null;
      let owner: User | null = null;
      if (!route.anonymous) {
        token = await doorkeeperToken({ authorization: railsReq.headers.get("authorization"), parameters: params, path: railsReq.path });
        const authorized = await doorkeeperAuthorize(token, route.scopes, { apiV2: true });
        if (!authorized.ok) {
          if (authorized.status === 401 && route.unauthorized) return { ...route.unauthorized(authorized.headers), rescued: true, paramsRead: true };
          return { status: authorized.status, body: "", contentType: "text/html", headers: authorized.headers, rescued: true, paramsRead: true };
        }
        if (route.requireScope) {
          const refusal = requireOauthScope(token, route.requireScope);
          if (refusal) return { status: refusal.status, body: JSON.stringify(refusal.body), contentType: "application/json; charset=utf-8", rescued: true, paramsRead: true };
        }
        owner = (await currentApiUser(token))!;
      }
      const input: ApiV2Input = { request: railsReq, url, routeParams: routeParams!, params, rawBody: bytes, token: token!, owner: owner!, state: {} };
      const halted = await route.before?.(input);
      if (halted) return { ...halted, rescued: true };
      const result = await route.run(input);
      if (owner) await markCliUser(railsReq, owner);
      return result;
    } catch (error) {
      // A NotPortedError is thrown before the first write of its transaction, so Rails can take the request whole.
      if (error instanceof NotPortedError || error instanceof PageNotPortedError) {
        console.warn(`[api-v2] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
        throw new HandBackToRails(error.message);
      }
      throw error;
    }
  });
}

// For a `rawJsonBody` route: params are the query string, plus the body when it is an object. A JSON array or scalar is what the
// action reads from the raw body, so it is not params. Any other body that fails to parse still hands back.
function rawJsonParams(url: URL, contentType: string | null, bytes: Uint8Array): Params {
  try {
    return requestParams(url, contentType, bytes);
  } catch (error) {
    if (!(error instanceof HandBackToRails)) throw error;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw error;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) throw error;
    return parseNestedQuery(url.search.replace(/^\?/u, ""));
  }
}

async function handBack(request: Request, error: HandBackToRails): Promise<Response> {
  console.warn(`[api-v2] ${request.method} ${new URL(request.url).pathname} handed back to Rails: ${error.message}`);
  return forwardToRails(request);
}

export { requireOauthScope };

// before_action :fetch_product (Api::V2::BaseController), keyed by the route's `:link_id` or `:id`.
export const loadProduct = (param: "link_id" | "id" = "link_id") =>
  async function before(input: ApiV2Input): Promise<Rendered | undefined> {
    const product = await fetchProduct(input.owner, input.routeParams[param]);
    if (!product) return errorWithObject("product", null);
    input.state.product = product;
    return undefined;
  };
