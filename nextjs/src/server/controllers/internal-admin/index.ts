// Dispatcher of the internal admin API. The proxy rewrites a request for a route marked `handler: "internal-admin"` in routes.json (on the
// API host as `/internal/admin/...`, on the Gumroad domain as `/api/internal/admin/...`) to /gr-public/internal-admin, which lands in
// `internalAdminResponse`: the same chain as a page request (processAction), then the token check and the action (./registry.ts).
//
// The controllers skip protect_from_forgery, so no CSRF check applies. Whatever the port cannot prove goes to Rails whole, body
// included, before the action's first write (a NotPortedError, a body Node does not parse).
import { NotPortedError } from "../../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../../page-props/not-ported.ts";
import { PAGE_URL_HEADER } from "../../page-props/render-state.ts";
import { forwardToRails, HandBackToRails, processAction } from "../application-controller.ts";
import { parseBody, parseNestedQuery, type Params } from "../rails-body.ts";
import { dispatchAdmin } from "./registry.ts";
import "./auth.ts";
import "./campaigns.ts";
import "./piracy-reports.ts";
import "./piracy-report-detail.ts";
import "./piracy-report-writes.ts";
import "./users.ts";
import "./user-writes.ts";
import "./user-watch.ts";
import "./users-reads.ts";
import "./admin-web.ts";

export async function internalAdminResponse(incoming: Request): Promise<Response> {
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const bytes = new Uint8Array(await incoming.arrayBuffer());
  const url = new URL(target, `${protocol}://${host}`);
  const bodiless = incoming.method === "GET" || incoming.method === "HEAD";
  const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: bytes.length > 0 && !bodiless ? bytes : undefined });
  const contentType = request.headers.get("content-type");

  let bodyParams: Params;
  try {
    bodyParams = bodiless ? {} : parseBody(contentType, bytes);
  } catch (error) {
    if (error instanceof HandBackToRails) return forwardToRails(request);
    throw error;
  }
  const params: Params = { ...parseNestedQuery(url.search.replace(/^\?/u, "")), ...bodyParams };

  return processAction(request, {}, async ({ request: railsReq }) => {
    try {
      const rendered = await dispatchAdmin({ request: { ...railsReq, method: railsReq.method === "HEAD" ? "GET" : railsReq.method }, url, params, bodyParams, contentType });
      if (rendered === null) throw new HandBackToRails("an internal admin route Node does not serve");
      return rendered;
    } catch (error) {
      if (error instanceof NotPortedError || error instanceof PageNotPortedError) {
        console.warn(`[internal-admin] ${request.method} ${url.pathname} handed back to Rails: ${error.message}`);
        throw new HandBackToRails(error.message);
      }
      throw error;
    }
  });
}
