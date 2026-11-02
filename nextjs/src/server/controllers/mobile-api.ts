// Api::Mobile::BaseController and the shape every endpoint under /mobile on the API host shares: the MOBILE_TOKEN check, Doorkeeper's
// bearer token (`doorkeeper_authorize!`), the impersonation of a team member and the brand account a token acts as.
//
// routes.json marks each route `hosts: "api"` with `handler: "mobile"`; the proxy rewrites it to /gr-public/mobile
// (app/gr-public/[action]/route.ts), which lands in `mobileResponse` and picks the action by method and path.
//
// A write goes through the same chain as a GET, except for what Rails' `protect_from_forgery` (null_session) does to a request with no
// CSRF token: the session, the cookie jar and the guid are dropped, so the response carries no cookies. A write that carries any
// cookie goes to Rails, which would have to decide whether the token it holds is a valid one.
import { timingSafeEqual } from "node:crypto";

import type { OauthAccessToken, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { ApiUserNotFoundError, brandTeamMembership, currentApiUser, doorkeeperAuthorize, doorkeeperToken } from "../auth/api-token.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { getConfig } from "../infra/config.ts";
import { NotPortedError, UserFlags } from "../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { PAGE_URL_HEADER } from "../page-props/render-state.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { forwardToRails, HandBackToRails, processAction, RoutingError, type ActionOptions, type ActionResult, type Rendered } from "./application-controller.ts";
import { requestParams, type Params } from "./rails-body.ts";
import { railsRequest, type RailsRequest } from "./rails-request.ts";

const JSON_TYPE = "application/json; charset=utf-8";
export const NOT_FOUND = 404;
export const UNAUTHORIZED = 401;
export const FORBIDDEN = 403;
export const UNPROCESSABLE_ENTITY = 422;

// `render json:`; `rescued` marks a before_action's halt, whose after_actions (the XSRF-TOKEN cookie) do not run.
export const renderJson = (body: unknown, status = 200): Rendered => ({ status, body: esJson(body as JsonValue), contentType: JSON_TYPE, paramsRead: true });
const halted = (response: Rendered): Rendered => ({ ...response, rescued: true });

// Api::Mobile::BaseController#fetch_error
export const fetchError = (message: string, status = NOT_FOUND): Rendered => halted(renderJson({ success: false, message }, status));

export type MobileInput = {
  request: RailsRequest;
  url: URL;
  // request.parameters: query string, body, then the route's own segments.
  params: Params;
  routeParams: Record<string, string>;
  rawBody: Uint8Array;
};

export type MobileAuth = {
  token: OauthAccessToken;
  // CurrentApiUser#current_api_user
  apiUser: User;
  // Api::Mobile::BaseController#current_resource_owner: the impersonated user, else the token's owner.
  owner: User;
  impersonated: User | null;
  // Api::Mobile::BaseController#account_holder: the team member behind a brand token, else the token's owner.
  accountHolder: User;
};

// Impersonate#impersonated_user for an API request: a team member's token acts as the user the staff member chose.
async function impersonatedUserOf(actor: User): Promise<User | null> {
  if (!UserFlags.isSet(actor.flags, "is_team_member")) return null;
  const id = await prismaAuthStore.impersonatedUserId(actor.id);
  if (id === null || !/^\d+$/u.test(id)) return null;
  return prismaAuthStore.findAliveUserById(BigInt(id));
}

export async function resolveMobileAuth(token: OauthAccessToken): Promise<MobileAuth> {
  const apiUser = (await currentApiUser(token))!;
  const membership = await brandTeamMembership(token);
  const memberUser = membership === null ? null : await db.user.findUnique({ where: { id: membership.user_id } });
  // current_user_from_api_or_web: a brand token acts as its team member, so it never picks up the brand owner's impersonation.
  const actor = memberUser ?? apiUser;
  const impersonated = await impersonatedUserOf(actor);
  return { token, apiUser, owner: impersonated ?? apiUser, impersonated, accountHolder: memberUser ?? apiUser };
}

// Api::Mobile::BaseController#check_mobile_token. A param that is not a string is `to_s`ed by Rails into something that never matches.
function mobileTokenValid(params: Params): boolean {
  const known = getConfig("MOBILE_TOKEN");
  if (known === undefined) throw new HandBackToRails("MOBILE_TOKEN is not configured");
  const given = Buffer.from(typeof params.mobile_token === "string" ? params.mobile_token : params.mobile_token == null ? "" : "\0");
  const expected = Buffer.from(known);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type MobileAction = {
  method: string;
  // "/mobile/calls/:id"
  pattern: string;
  // `doorkeeper_authorize! *scopes`; null for an action that does not require a token.
  scopes: string[] | null;
  // The action's own before_actions and body. `auth` is null when `scopes` is null and no valid token came with the request.
  run(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult>;
  options?: ActionOptions;
  // The controller's `skip_before_action :verify_authenticity_token`: the request keeps its session and cookies.
  skipForgeryProtection?: boolean;
};

const REGISTRY: MobileAction[] = [];

export function registerMobile(...actions: MobileAction[]): void {
  for (const action of actions) if (!REGISTRY.some((known) => known.method === action.method && known.pattern === action.pattern)) REGISTRY.push(action);
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/.?]+)";
    })
    .join("/");
  const match = new RegExp(`^${source}$`, "u").exec(path);
  return match === null ? null : Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
}

// Doorkeeper::Rails::Helpers#doorkeeper_authorize!: `head 401` (WWW-Authenticate) or `head 403`, both halting the chain.
async function authorize(token: OauthAccessToken | null, scopes: string[]): Promise<Rendered | null> {
  const result = await doorkeeperAuthorize(token, scopes);
  if (result.ok) return null;
  return { status: result.status, body: "", contentType: "text/html", headers: Object.fromEntries(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value])), rescued: true };
}

const READ_METHODS = ["GET", "HEAD"];

export async function mobileResponse(incoming: Request): Promise<Response> {
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const bytes = new Uint8Array(await incoming.arrayBuffer());
  const url = new URL(target, `${protocol}://${host}`);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: bytes.length > 0 && !READ_METHODS.includes(incoming.method) ? bytes : undefined });

  const method = request.method === "HEAD" ? "GET" : request.method;
  const found = REGISTRY.map((action) => ({ action, routeParams: action.method === method ? matchPattern(action.pattern, url.pathname) : null })).find(({ routeParams }) => routeParams !== null);
  if (found === undefined) return forwardToRails(request);
  const { action, routeParams } = found;

  let params: Params;
  try {
    params = requestParams(url, request.headers.get("content-type"), bytes);
    // protect_from_forgery runs the action with a null session: nothing is read from, or written to, the visitor's cookies.
    if (!READ_METHODS.includes(request.method) && !action.skipForgeryProtection && request.headers.get("cookie")) throw new HandBackToRails("a write that carries cookies");
  } catch (error) {
    if (error instanceof HandBackToRails) {
      console.warn(`[mobile] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
      return forwardToRails(request);
    }
    throw error;
  }

  const options: ActionOptions = { ...action.options, bare: !READ_METHODS.includes(request.method) && !action.skipForgeryProtection };
  return processAction(request, options, async ({ request: railsReq }) => {
    const input: MobileInput = { request: railsReq, url, params: { ...params, ...routeParams }, routeParams: routeParams!, rawBody: bytes };
    if (!mobileTokenValid(params)) return fetchError("Invalid request", UNAUTHORIZED);
    let token: OauthAccessToken | null = null;
    let auth: MobileAuth | null = null;
    try {
      token = await doorkeeperToken({ authorization: request.headers.get("authorization"), parameters: input.params, path: railsReq.path });
      if (action.scopes !== null) {
        const refused = await authorize(token, action.scopes);
        if (refused !== null) return refused;
      }
      if (token !== null) auth = await resolveMobileAuth(token);
    } catch (error) {
      // User.find raises for a token whose owner is gone: a 404 page in Rails.
      if (error instanceof ApiUserNotFoundError) throw new RoutingError(error.message);
      if (error instanceof TypeError) throw new HandBackToRails(error.message);
      throw error;
    }
    try {
      return await action.run(input, auth);
    } catch (error) {
      // A NotPortedError is thrown before the first write of its transaction, so Rails can take the request whole.
      if (error instanceof NotPortedError || error instanceof PageNotPortedError) {
        console.warn(`[mobile] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
        throw new HandBackToRails(error.message);
      }
      if (!(error instanceof HandBackToRails)) console.error(`[mobile] ${request.method} ${url.pathname} failed`, error);
      throw error;
    }
  });
}
