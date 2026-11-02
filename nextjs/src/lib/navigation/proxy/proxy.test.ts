import { describe, expect, it } from "vitest";

import { domainConfig } from "@/server/page-props/domain";

import { decideRoute } from "./decide";
import type { ProxyRequestInfo, RouteGate } from "./gate";
import { classifyHost, customDomainLookup } from "./hosts";
import { compileRouteTable } from "./route-table";

const production = domainConfig({ RAILS_ENV: "production" });
const development = domainConfig({ RAILS_ENV: "development" });

describe("classifyHost", () => {
  it("recognises the app hosts", () => {
    expect(classifyHost("gumroad.com", production)).toMatchObject({ gumroad: true, discover: true, api: false, sellerSubdomain: null });
    expect(classifyHost("app.gumroad.com", production)).toMatchObject({ gumroad: true, discover: false });
    expect(classifyHost("api.gumroad.com", production)).toMatchObject({ gumroad: false, api: true });
  });

  it("matches the third-party analytics host with Rails' unanchored, unescaped regexp", () => {
    expect(classifyHost("gumroad-analytics.com", production).thirdPartyAnalytics).toBe(true);
    expect(classifyHost("gumroad-analyticsXcom.evil.test", production).thirdPartyAnalytics).toBe(true);
  });

  it("finds seller subdomains by username (hyphens as underscores) or numeric external id", () => {
    expect(classifyHost("jane-doe.gumroad.com", production).sellerSubdomain).toEqual({ username: "jane_doe" });
    expect(classifyHost("12345.gumroad.com", production).sellerSubdomain).toEqual({ externalId: "12345" });
    expect(classifyHost("a.b.gumroad.com", production).sellerSubdomain).toBeNull();
  });

  it("ignores the port of ROOT_DOMAIN in development", () => {
    expect(classifyHost("jane.localhost", development).sellerSubdomain).toEqual({ username: "jane" });
    expect(classifyHost("anything.example.com", development).api).toBe(true);
  });

  it("looks custom domains up like CustomDomain.find_by_host", () => {
    expect(customDomainLookup("example.com")).toEqual(["example.com", "www.example.com"]);
    expect(customDomainLookup("www.example.co.uk")).toEqual(["example.co.uk", "www.example.co.uk"]);
    expect(customDomainLookup("shop.example.com")).toEqual(["shop.example.com"]);
    expect(customDomainLookup("localhost")).toBeNull();
  });
});

describe("domainConfig", () => {
  it("applies CUSTOM_DOMAIN like config/domain.rb", () => {
    const config = domainConfig({ RAILS_ENV: "staging", CUSTOM_DOMAIN: "pr-1.example.com", BRANCH_DEPLOYMENT: "true" });
    expect(config.domain).toBe("pr-1.example.com");
    expect(config.validRequestHosts).toContain("pr-1.example.com");
    expect(config.validApiRequestHosts).toEqual(["api.staging.gumroad.com", "api.pr-1.example.com", "pr-1.example.com"]);
    expect(config.validDiscoverRequestHost).toBe("pr-1.example.com");
  });
});

const routes = compileRouteTable({
  "/api/health": { flag: null, hosts: "any" },
  "/help/category/:slug": { flag: "nextjs_help_center_category", signedOutOnly: true, inertia: true },
  "/settings/password": "nextjs_settings_password",
});

const gate = (flags: string[], signedIn: boolean | null): RouteGate => ({
  isFlagEnabled: async (flag) => flags.includes(flag),
  isSignedIn: async () => signedIn,
});

const request = (url: string, init: { method?: string; headers?: Record<string, string> } = {}): ProxyRequestInfo => ({
  method: init.method ?? "GET",
  url: new URL(url),
  headers: new Headers(init.headers),
  cookies: new Map(),
});

describe("decideRoute", () => {
  const allOn = gate(["nextjs_help_center_category", "nextjs_settings_password"], false);

  it("serves a listed route from Next only when its flag is on", async () => {
    expect(await decideRoute(request("https://gumroad.com/settings/password"), routes, production, allOn)).toMatchObject({ action: "next" });
    expect(await decideRoute(request("https://gumroad.com/settings/password"), routes, production, gate([], false))).toEqual({ action: "rails" });
  });

  it("sends unlisted paths, other methods and other hosts to Rails", async () => {
    expect(await decideRoute(request("https://gumroad.com/dashboard"), routes, production, allOn)).toEqual({ action: "rails" });
    expect(await decideRoute(request("https://gumroad.com/settings/password", { method: "PUT" }), routes, production, allOn)).toEqual({ action: "rails" });
    expect(await decideRoute(request("https://jane.gumroad.com/settings/password"), routes, production, allOn)).toEqual({ action: "rails" });
  });

  it("leaves the format-suffixed path to Rails, which redirects it", async () => {
    expect(await decideRoute(request("https://gumroad.com/help/category/x.html"), routes, production, allOn)).toEqual({ action: "rails" });
  });

  it("keeps signed-out-only routes on Rails unless the visitor is known to be signed out", async () => {
    const url = "https://gumroad.com/help/category/316-open-an-account";
    expect(await decideRoute(request(url), routes, production, allOn)).toMatchObject({ action: "next" });
    expect(await decideRoute(request(url), routes, production, gate(["nextjs_help_center_category"], true))).toEqual({ action: "rails" });
    expect(await decideRoute(request(url), routes, production, gate(["nextjs_help_center_category"], null))).toEqual({ action: "rails" });
  });

  it("serves Next's own endpoints and assets without a flag", async () => {
    expect(await decideRoute(request("https://api.gumroad.com/api/health"), routes, production, gate([], null))).toMatchObject({ action: "next" });
    expect(await decideRoute(request("https://gumroad.com/_next/static/x.js"), routes, production, gate([], null))).toMatchObject({ action: "next" });
  });

  it("forwards Inertia protocol requests to Rails for converted routes that are not Inertia pages", async () => {
    const decision = await decideRoute(request("https://gumroad.com/settings/password", { headers: { "X-Inertia": "true" } }), routes, production, allOn);
    expect(decision).toEqual({ action: "rails" });
  });

  describe("Inertia protocol requests for an Inertia page", () => {
    const url = "https://gumroad.com/help/category/316-open-an-account";
    const inertia = { headers: { "X-Inertia": "true" } };

    it("are answered by Next when the page is on", async () => {
      expect(await decideRoute(request(url, inertia), routes, production, allOn)).toMatchObject({ action: "inertia" });
    });

    it("stay with Rails while the flag is off or the visitor may be signed in", async () => {
      expect(await decideRoute(request(url, inertia), routes, production, gate([], false))).toEqual({ action: "rails" });
      expect(await decideRoute(request(url, inertia), routes, production, gate(["nextjs_help_center_category"], true))).toEqual({ action: "rails" });
    });
  });

  it("turns a flight request for a Rails page into a hard navigation", async () => {
    const decision = await decideRoute(request("https://gumroad.com/dashboard", { headers: { RSC: "1" } }), routes, production, allOn);
    expect(decision).toEqual({ action: "hard-navigation" });
  });
});

describe("routes on the API host", () => {
  const apiRoutes = compileRouteTable({
    "/mobile/feature_flags/:id": { flag: "nextjs_mobile_feature_flags", hosts: "api", handler: "mobile" },
    "POST /mobile/devices": { flag: "nextjs_mobile_devices", hosts: "api", handler: "mobile" },
  });
  const on = gate(["nextjs_mobile_feature_flags", "nextjs_mobile_devices"], null);

  it("serves them on the API host only, for their own method", async () => {
    expect(await decideRoute(request("https://api.gumroad.com/mobile/feature_flags/x"), apiRoutes, production, on)).toMatchObject({ action: "handler", handler: "mobile" });
    expect(await decideRoute(request("https://api.gumroad.com/mobile/devices", { method: "POST" }), apiRoutes, production, on)).toMatchObject({ action: "handler", handler: "mobile" });
    expect(await decideRoute(request("https://api.gumroad.com/mobile/devices"), apiRoutes, production, on)).toEqual({ action: "rails" });
    expect(await decideRoute(request("https://gumroad.com/mobile/feature_flags/x"), apiRoutes, production, on)).toEqual({ action: "rails" });
  });

  it("keeps them on Rails while their flag is off", async () => {
    expect(await decideRoute(request("https://api.gumroad.com/mobile/feature_flags/x"), apiRoutes, production, gate([], null))).toEqual({ action: "rails" });
  });
});
