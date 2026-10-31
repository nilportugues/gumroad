import type { DomainConfig } from "@/server/page-props/domain";

import type { ProxyRequestInfo, RouteGate } from "./gate";
import { classifyHost } from "./hosts";
import { type CompiledRoute, matchRoute } from "./route-table";

export type RouteDecision =
  | { action: "next"; route: CompiledRoute | null }
  // Next's client router asked for a flight payload of a Rails page: answer with something that is not
  // one, and the client falls back to a full page load, instead of Rails rendering the page twice.
  | { action: "hard-navigation" }
  | { action: "rails" };

// Requests Next.js answers no matter what: its own assets and dev tooling.
const NEXT_INTERNAL = /^\/(_next|__nextjs)/;

export async function decideRoute(
  request: ProxyRequestInfo,
  routes: CompiledRoute[],
  config: DomainConfig,
  gate: RouteGate,
): Promise<RouteDecision> {
  if (NEXT_INTERNAL.test(request.url.pathname)) return { action: "next", route: null };

  const isFlightRequest = request.headers.get("rsc") === "1";
  const toRails: RouteDecision = isFlightRequest ? { action: "hard-navigation" } : { action: "rails" };

  // The navigation compat module speaks Inertia only to Rails (see router.ts); Next never does.
  if (request.headers.get("x-inertia") === "true") return { action: "rails" };

  const hostname = request.url.hostname;
  const route = matchRoute(routes, request.method, request.url.pathname, classifyHost(hostname, config));
  if (!route) return toRails;
  if (route.flag === null) return { action: "next", route };
  if (!(await gate.isFlagEnabled(route.flag, request))) return toRails;
  if (route.signedOutOnly && (await gate.isSignedIn(request)) !== false) return toRails;
  return { action: "next", route };
}
