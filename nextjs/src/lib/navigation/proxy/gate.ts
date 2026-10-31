// What the proxy asks before serving a route from Next.js. WS-06 replaces the flag lookup with
// Flipper and WS-03 the session probe with the Rails-session bridge, via `setRouteGate`.
export type ProxyRequestInfo = {
  method: string;
  url: URL;
  headers: Headers;
  cookies: Map<string, string>;
};

export interface RouteGate {
  // Flipper `Feature.active?(flag)`, actor-aware if the implementation can identify the user.
  isFlagEnabled(flag: string, request: ProxyRequestInfo): Promise<boolean>;
  // Whether the Rails session has a signed-in user; null when it cannot tell.
  isSignedIn(request: ProxyRequestInfo): Promise<boolean | null>;
}

// Until Flipper is ported, flags are turned on locally with NEXTJS_ROUTE_FLAGS=flag_a,flag_b.
export const envRouteGate: RouteGate = {
  async isFlagEnabled(flag) {
    return (process.env.NEXTJS_ROUTE_FLAGS ?? "").split(",").map((name) => name.trim()).includes(flag);
  },
  async isSignedIn() {
    return process.env.NEXTJS_ASSUME_SIGNED_OUT === "1" ? false : null;
  },
};

let gate: RouteGate = envRouteGate;

export function setRouteGate(next: RouteGate) {
  gate = next;
}

export function routeGate(): RouteGate {
  return gate;
}
