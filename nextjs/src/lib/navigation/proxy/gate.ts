// What the proxy asks before serving a route from Next.js. Deployed environments use
// server/proxy-gate.ts (Flipper and the Rails session); envRouteGate is for local runs.
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
  // Whether Devise's rememberable strategy would sign this request in (no usable session, but a
  // remember cookie). That writes the session and the tracked sign-in fields, so Rails serves it.
  signsInViaRememberCookie?(request: ProxyRequestInfo): Promise<boolean>;
  // What Rails' route constraints make of a host that is not Gumroad's: a custom domain that points at
  // a product (ProductCustomDomainConstraint, checked first), a seller's subdomain or custom domain
  // (UserCustomDomainConstraint), or neither. A gate that cannot tell leaves the host-shape match in
  // route-table.ts as the only check.
  hostKind?(request: ProxyRequestInfo): Promise<"product" | "user" | null>;
}

// Local runs turn flags on with NEXTJS_ROUTE_FLAGS=flag_a,flag_b.
export const envRouteGate: RouteGate = {
  async isFlagEnabled(flag) {
    return (process.env.NEXTJS_ROUTE_FLAGS ?? "").split(",").map((name) => name.trim()).includes(flag);
  },
  async isSignedIn() {
    return process.env.NEXTJS_ASSUME_SIGNED_OUT === "1" ? false : null;
  },
  async hostKind(request) {
    return (await import("@/server/host-kind")).hostKindOf(request.url, request.headers);
  },
};

let gate: RouteGate = envRouteGate;

export function setRouteGate(next: RouteGate) {
  gate = next;
}

export function routeGate(): RouteGate {
  return gate;
}
