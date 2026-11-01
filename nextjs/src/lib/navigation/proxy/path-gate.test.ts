import { describe, expect, it } from "vitest";

import type { DomainConfig } from "@/server/page-props/domain";

import { decideRoute } from "./decide";
import type { ProxyRequestInfo, RouteGate } from "./gate";
import { classifyHost } from "./hosts";
import { compileRouteTable, matchRoute } from "./route-table";

const config: DomainConfig = {
  protocol: "http",
  domain: "app.test.gumroad.com:31337",
  assetDomain: "test.gumroad.com:31337",
  rootDomain: "test.gumroad.com:31337",
  shortDomain: "short.test.gumroad.com:31337",
  discoverDomain: "test.gumroad.com:31337",
  apiDomain: "api.test.gumroad.com:31337",
  thirdPartyAnalyticsDomain: "analytics.test.gumroad.com",
  validRequestHosts: ["app.test.gumroad.com", "test.gumroad.com"],
  validApiRequestHosts: ["api.test.gumroad.com"],
  validDiscoverRequestHost: "test.gumroad.com",
  railsEnv: "test",
};

// The glob comes first in the table, as it would if a later workstream appended a static route after it.
const routes = compileRouteTable({
  "/*taxonomy": { flag: "nextjs_discover", inertia: true, pathGate: "taxonomy" },
  "/discover": { flag: "nextjs_discover", inertia: true },
  "/login": { flag: "nextjs_auth_login", inertia: true },
});

const request = (path: string): ProxyRequestInfo => ({ method: "GET", url: new URL(`http://test.gumroad.com${path}`), headers: new Headers(), cookies: new Map() });
const gate = (taxonomyPaths: string[]): RouteGate => ({
  isFlagEnabled: async () => true,
  isSignedIn: async () => false,
  taxonomyPath: async ({ url }) => taxonomyPaths.includes(url.pathname),
});

describe("a route with a path gate", () => {
  it("matches after every route without one", () => {
    const host = classifyHost("test.gumroad.com", config);
    expect(matchRoute(routes, "GET", "/discover", host)?.pattern).toBe("/discover");
    expect(matchRoute(routes, "GET", "/login", host)?.pattern).toBe("/login");
    expect(matchRoute(routes, "GET", "/3d/3d-modeling", host)?.pattern).toBe("/*taxonomy");
  });

  it("is served by Next.js for a taxonomy path", async () => {
    const decision = await decideRoute(request("/3d/3d-modeling"), routes, config, gate(["/3d/3d-modeling"]));
    expect(decision.action).toBe("next");
  });

  it("stays with Rails for a path that is not a taxonomy", async () => {
    expect((await decideRoute(request("/some-seller-page"), routes, config, gate(["/3d"]))).action).toBe("rails");
  });

  it("stays with Rails when the gate cannot tell", async () => {
    const blind: RouteGate = { isFlagEnabled: async () => true, isSignedIn: async () => false };
    expect((await decideRoute(request("/3d"), routes, config, blind)).action).toBe("rails");
  });
});
