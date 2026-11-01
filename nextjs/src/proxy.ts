// The strangler routing proxy (Next 16 renamed middleware.ts to proxy.ts; it runs on Node.js, which
// the Flipper and session lookups need). Routes listed in routes.json with their flag on are served
// here; every other request is forwarded to Rails unchanged.
import { type NextRequest, NextResponse } from "next/server";

import { decideRoute } from "@/lib/navigation/proxy/decide";
import { routeGate, setRouteGate } from "@/lib/navigation/proxy/gate";
import { compileRouteTable, type RouteTable } from "@/lib/navigation/proxy/route-table";
import { pageEnvelope } from "@/server/controllers/application-controller";
import { HOST_PAGE_PREFIX, INERTIA_PAGE_PATH } from "@/server/controllers/inertia-page";
import { getRequiredConfig } from "@/server/infra/config";
import { domainConfig } from "@/server/page-props/domain";
import { PAGES } from "@/server/page-props/pages";
import { encodeRenderState, PAGE_URL_HEADER, RENDER_STATE_HEADER } from "@/server/page-props/render-state";
import { railsRouteGate } from "@/server/proxy-gate";
import { redirectsBeforeRendering } from "@/server/proxy-preflight";

import routeTable from "../routes.json";

const routes = compileRouteTable(routeTable as RouteTable);

// NEXTJS_ROUTE_FLAGS keeps the env-var gate for local runs without Redis or a Rails session.
if (process.env.NEXTJS_ROUTE_FLAGS === undefined) setRouteGate(railsRouteGate);

// Rails' request.host: the last X-Forwarded-Host entry wins over Host.
function originalHost(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host");
  return (forwarded ? forwarded.split(/,\s?/).at(-1) : request.headers.get("host")) ?? request.nextUrl.host;
}

export async function proxy(request: NextRequest) {
  const host = originalHost(request);
  const url = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, `${request.nextUrl.protocol}//${host}`);
  const decision = await decideRoute(
    { method: request.method, url, headers: request.headers, cookies: new Map(request.cookies.getAll().map((c) => [c.name, c.value])) },
    routes,
    domainConfig(process.env),
    routeGate(),
  );

  // The request as the pages see it: the visitor's host, and the headers only this proxy may set.
  const forwarded = new Headers(request.headers);
  forwarded.delete(RENDER_STATE_HEADER);
  forwarded.set(PAGE_URL_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  forwarded.set("x-forwarded-host", host);
  forwarded.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));

  // Next.js adds a body to a redirect the proxy builds itself, which Rails' redirects do not have, so
  // the route handler answers them instead (processAction, from inside a request).
  const viaHandler = () => NextResponse.rewrite(new URL(INERTIA_PAGE_PATH, request.url), { request: { headers: forwarded } });

  if (decision.action === "inertia") return viaHandler();
  if (decision.action === "next") {
    if (!decision.route) return NextResponse.next();
    if (!decision.route.inertia) return NextResponse.next();
    if (await redirectsBeforeRendering(decision.route.pattern, url, request)) return viaHandler();

    // An App Router page cannot set headers or cookies, so the Rails envelope is built here and
    // attached to the response the page renders (see pageEnvelope).
    const envelope = await pageEnvelope(request, PAGES[decision.route.pattern]?.options);
    // The handler answers a redirect or a bare 400 (a before_action's `head`) through processAction.
    if ("response" in envelope) return envelope.response.headers.has("location") || envelope.response.status === 400 ? viaHandler() : envelope.response;
    forwarded.set(RENDER_STATE_HEADER, encodeRenderState(envelope.renderState));
    // A page that only exists on seller or product-domain hosts lives under /gr-host/<scope>, because
    // the same path can be a Gumroad-domain page (`/affiliates`) and App Router routes by path alone.
    const response =
      decision.route.hosts === "seller" || decision.route.hosts === "product"
        ? NextResponse.rewrite(new URL(`${HOST_PAGE_PREFIX}/${decision.route.hosts}${request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname}`, request.url), { request: { headers: forwarded } })
        : NextResponse.next({ request: { headers: forwarded } });
    envelope.headers.delete("content-type");
    for (const [name, value] of envelope.headers) if (name !== "set-cookie") response.headers.set(name, value);
    for (const cookie of envelope.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
    return response;
  }
  if (decision.action === "hard-navigation") return new NextResponse(null, { status: 200, headers: { "content-type": "text/plain" } });

  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, getRequiredConfig("RAILS_ORIGIN"));
  const headers = new Headers(request.headers);
  // Host-based routing in Rails (subdomains, custom domains) must see the visitor's host, not RAILS_ORIGIN's.
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = {
  // Static chunks never need a routing decision; everything else, including /api, does.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
