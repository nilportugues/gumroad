import type { DomainConfig } from "@/server/page-props/domain";

import type { ProxyRequestInfo, RouteGate } from "./gate";
import { classifyHost } from "./hosts";
import { type CompiledRoute, matchRoutes } from "./route-table";

export type RouteDecision =
  | { action: "next"; route: CompiledRoute | null }
  // A mutation Node ports: the /gr-mutation handler answers it, or forwards it to Rails with its body.
  | { action: "mutation"; route: CompiledRoute }
  // An X-Inertia request for a page Next.js serves: answered with the Inertia JSON (or 409).
  | { action: "inertia"; route: CompiledRoute }
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

  // The navigation compat module speaks Inertia only to Rails (see router.ts), so these requests come
  // from pages Rails still serves.
  const isInertiaRequest = request.headers.get("x-inertia") === "true";

  const hostname = request.url.hostname;
  const candidates = matchRoutes(routes, request.method, request.url.pathname, classifyHost(hostname, config));
  let route: CompiledRoute | null = null;
  for (const candidate of candidates) {
    if ((candidate.hosts === "seller" || candidate.hosts === "product") && gate.hostKind) {
      if ((await gate.hostKind(request)) !== (candidate.hosts === "product" ? "product" : "user")) continue;
    }
    route = candidate;
    break;
  }
  if (!route) return toRails;
  if (route.flag !== null) {
    if (!(await gate.isFlagEnabled(route.flag, request))) return toRails;
    if (route.signedOutOnly && (await gate.isSignedIn(request)) !== false) return toRails;
    if (route.signedInOnly && (await gate.isSignedIn(request)) === false) return toRails;
    if (await gate.signsInViaRememberCookie?.(request)) return toRails;
  }
  if (route.mutation) return { action: "mutation", route };
  if (isInertiaRequest) return route.inertia ? { action: "inertia", route } : { action: "rails" };
  if (route.inertia === "only") return toRails;
  return { action: "next", route };
}
