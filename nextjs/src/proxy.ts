// The strangler routing proxy (Next 16 renamed middleware.ts to proxy.ts; it runs on Node.js, which
// the Flipper and session lookups need). Routes listed in routes.json with their flag on are served
// here; every other request is forwarded to Rails unchanged.
import { type NextRequest, NextResponse } from "next/server";

import { decideRoute } from "@/lib/navigation/proxy/decide";
import { routeGate, setRouteGate } from "@/lib/navigation/proxy/gate";
import { compileRouteTable, type RouteTable } from "@/lib/navigation/proxy/route-table";
import { getRequiredConfig } from "@/server/infra/config";
import { domainConfig } from "@/server/page-props/domain";
import { railsRouteGate } from "@/server/proxy-gate";

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

  if (decision.action === "next") return NextResponse.next();
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
