// POST, PUT, PATCH and DELETE actions served by Node. The proxy rewrites a request for a route marked `mutation` in routes.json to
// /gr-mutation (app/gr-mutation/route.ts), which runs the same chain as a page request (processAction) and then the action.
//
// Whatever the port cannot prove goes to Rails whole, body included, before its first write: a request whose CSRF token or Origin
// Rails would judge differently (Rails answers with a null session), a body Node does not parse, and any NotPortedError.
import { HandBackToRails, forwardToRails, processAction, sessionCsrfToken, type ActionContext, type ActionOptions, type ActionResult, type Chain } from "./application-controller.ts";
import { MUTATION_PATH } from "./inertia-page.ts";
import { railsRequest, type RailsRequest } from "./rails-request.ts";
import { requestFormat } from "./rails-params.ts";
import { requestParams, type Params } from "./rails-body.ts";
import { globalCsrfToken, unmaskToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { defaultUrlOptions } from "../page-props/load-page.ts";
import { PAGE_URL_HEADER } from "../page-props/render-state.ts";
import { withPaperTrailRequest } from "../models/concerns/paper-trail.ts";
import { NotPortedError } from "../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { randomUUID } from "node:crypto";
import { railsEnv } from "../infra/rails-env.ts";
import { resetRailsCacheForTesting } from "../cache/rails-cache.ts";

export { MUTATION_PATH };

// A path segment as Rails' route helpers write it: unreserved characters and sub-delimiters stay as they are (an external id
// ends in "="), where js-routes escapes them.
export const railsSegment = (value: string): string => encodeURIComponent(value).replace(/%(21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

export type MutationInput = {
  request: RailsRequest;
  context: ActionContext["context"];
  peekState: ActionContext["peekState"];
  // Reads the render state and consumes the flash, for an action that renders a page.
  takeRenderState: ActionContext["takeRenderState"];
  chain: ActionContext["chain"];
  url: URL;
  urlOptions: { protocol: string; host: string };
  // The route's `:id` and friends.
  routeParams: Record<string, string>;
  // request.parameters (query string, then body).
  params: Params;
  // request.raw_post.
  rawBody: Uint8Array;
  // The path and query as the proxy forwarded them, before `new URL` resolved dot segments (Rails sees `a/../b` as it was sent).
  rawTarget?: string;
};

export type MutationSpec = {
  method: string;
  // "/emails/:id"
  pattern: string;
  options?: ActionOptions;
  // A `render json:` action: it takes a request that asks for JSON (the dashboard's `request()`) and hands back any other format.
  json?: boolean;
  // The controller's `skip_before_action :verify_authenticity_token`: no CSRF check, and no format check either (a webhook has no
  // Pundit to answer 401 JSON).
  skipForgeryProtection?: boolean;
  // The action reads request.raw_post itself (a webhook): `params` is left empty and no body is parsed or refused here.
  rawBody?: boolean;
  // Formats the action answers like Rails does. Pundit's 401 JSON is what the default (html only) leaves to Rails.
  formats?: ("html" | "json" | "any")[];
  // "any": the action answers every format itself (a public JSON endpoint with no Pundit in the way).
  // The Rack::Attack rule (config/initializers/rack_attack.rb) that counts this route in Rails' Redis. A Node answer would skip that counter, so
  // the route is not in routes.json and, were a request to arrive anyway, Rails takes it whole.
  railsOnly?: string;
  run(input: MutationInput): Promise<ActionResult>;
};

const REGISTRY: MutationSpec[] = [];

export function registerMutations(...specs: MutationSpec[]): void {
  for (const spec of specs) if (!REGISTRY.some((known) => known.method === spec.method && known.pattern === spec.pattern)) REGISTRY.push(spec);
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      // `:id([A-Za-z0-9_=-]+).json`: a constrained parameter and a literal suffix, as routes.json writes a format-bound route.
      const constrained = /^:(\w+)\((.+)\)(.*)$/u.exec(segment);
      if (constrained) {
        names.push(constrained[1]!);
        return `(${constrained[2]})${constrained[3]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
      }
      // `*path`: the rest of the path, as a Rails glob captures it.
      if (segment.startsWith("*")) {
        names.push(segment.slice(1));
        return "(.+)";
      }
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/.?]+)";
    })
    .join("/");
  const match = new RegExp(`^${source}$`, "u").exec(path);
  return match === null ? null : Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
}

// ActionController::RequestForgeryProtection#verified_request? for the global tokens Inertia sends (X-XSRF-TOKEN, which
// InertiaRails::Middleware copies to X-CSRF-Token, or X-CSRF-Token itself). A per-form token, a missing session token or a foreign
// Origin is left to Rails, which then runs the action with a null session.
export function csrfVerified(request: RailsRequest, params: Params): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== `${request.protocol}${request.hostWithPort}`) return false;
  const session = sessionCsrfToken(request);
  if (session === null) return false;
  const real = Buffer.from(session, "base64url");
  const global = globalCsrfToken(session);
  const tokens = [params.authenticity_token, request.headers.get("x-inertia") ? (request.headers.get("x-xsrf-token") ?? request.headers.get("x-csrf-token")) : request.headers.get("x-csrf-token")];
  return tokens.some((token) => {
    if (typeof token !== "string" || token === "") return false;
    const decoded = Buffer.from(token, "base64url");
    if (decoded.length === 32) return decoded.equals(global);
    if (decoded.length !== 64) return false;
    const unmasked = unmaskToken(token);
    return unmasked.equals(global) || unmasked.equals(real);
  });
}

const PRIVATE_ADDRESS = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/u;

// ActionDispatch::RemoteIp trusts private proxies, so the client is the rightmost X-Forwarded-For entry that is not private.
export function remoteIp(request: RailsRequest): string | null {
  const addresses = (request.headers.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return [...addresses].reverse().find((address) => !PRIVATE_ADDRESS.test(address)) ?? addresses[0] ?? null;
}

export async function mutationResponse(incoming: Request): Promise<Response> {
  // The replay harness seeds each example into an empty database, so a cache entry keyed by a row id must not outlive it.
  if (railsEnv() === "test" && incoming.headers.has("x-parity-reset-cache")) resetRailsCacheForTesting();
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const bytes = new Uint8Array(await incoming.arrayBuffer());
  const url = new URL(target, `${protocol}://${host}`);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: bytes.length > 0 ? bytes : undefined });

  // A literal segment wins over a parameter (`/edit` over `/:slug`), as the more specific route is the one Rails declares first.
  const literalSegments = (pattern: string) => pattern.split("/").filter((segment) => segment !== "" && !/^[:*]/u.test(segment)).length;
  const spec = REGISTRY.map((candidate) => ({ candidate, routeParams: candidate.method === request.method ? matchPattern(candidate.pattern, url.pathname) : null }))
    .filter(({ routeParams }) => routeParams !== null)
    .reduce<{ candidate: MutationSpec; routeParams: Record<string, string> | null } | undefined>(
      (best, entry) => (best === undefined || literalSegments(entry.candidate.pattern) > literalSegments(best.candidate.pattern) ? entry : best),
      undefined,
    );
  if (spec === undefined || spec.candidate.railsOnly !== undefined) return forwardToRails(request);
  const { candidate, routeParams } = spec;

  let params: Params;
  try {
    params = candidate.rawBody ? {} : requestParams(url, request.headers.get("content-type"), bytes);
    // Pundit answers 401 JSON to a request that is not HTML.
    if (!candidate.skipForgeryProtection) {
      const formats = candidate.formats ?? [candidate.json ? "json" : "html"];
      if (!formats.includes("any") && !formats.includes(requestFormat(railsRequest(request)) as "html" | "json")) throw new HandBackToRails("a request whose format is not HTML");
      if (!csrfVerified(railsRequest(request), params)) throw new HandBackToRails("a request Rails would run with a null session");
    }
  } catch (error) {
    if (error instanceof HandBackToRails) {
      console.warn(`[mutation] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
      return forwardToRails(request);
    }
    throw error;
  }

  const { prepended } = candidate.options ?? {};
  const options = prepended ? { ...candidate.options, prepended: (chain: Chain) => prepended(chain, params) } : (candidate.options ?? {});
  return processAction(request, options, async ({ request: railsReq, context, peekState, takeRenderState, chain }) => {
    const config = domainConfig(process.env);
    const actionUrl = new URL(`${railsReq.path}${railsReq.queryString === "" ? "" : `?${railsReq.queryString}`}`, `${railsReq.protocol}${railsReq.hostWithPort}`);
    try {
      const user = railsLoggedInUser(context);
      // ApplicationController#set_paper_trail_whodunnit and #info_for_paper_trail. request.remote_ip is approximated by the
      // rightmost public X-Forwarded-For entry, and request.uuid by X-Request-Id.
      const paperTrail = {
        whodunnit: user === null ? null : String(user.id),
        controllerInfo: { remote_ip: remoteIp(railsReq), request_path: railsReq.path, request_uuid: railsReq.headers.get("x-request-id") ?? randomUUID() },
      };
      return await withPaperTrailRequest(paperTrail, () => candidate.run({ request: railsReq, context, peekState, takeRenderState, chain, url: actionUrl, urlOptions: defaultUrlOptions(actionUrl, config), routeParams: routeParams!, params, rawBody: bytes, rawTarget: target }));
    } catch (error) {
      // A NotPortedError is thrown before the first write of its transaction, so Rails can take the request whole.
      if (error instanceof NotPortedError || error instanceof PageNotPortedError) {
        console.warn(`[mutation] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
        throw new HandBackToRails(error.message);
      }
      console.error(`[mutation] ${request.method} ${url.pathname} failed`, error);
      throw error;
    }
  });
}
