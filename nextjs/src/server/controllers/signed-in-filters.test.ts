import { describe, expect, it } from "vitest";

import { dashboardNavRequest, dashboardPath, deleteCookieHeader, formatIsHtml, navItemForPath } from "./signed-in-filters.ts";
import type { RailsRequest } from "./rails-request.ts";

function request(path: string, headers: Record<string, string> = {}, method = "GET"): RailsRequest {
  return { method, path, queryString: "", headers: new Headers(headers), host: "app.test.gumroad.com", hostWithPort: "app.test.gumroad.com", protocol: "http://", cookies: new Map() };
}

const BROWSER_XML_FIRST = "text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5";
const XHR = { "x-requested-with": "XMLHttpRequest" };

describe("formatIsHtml", () => {
  // Expectations recorded from ActionDispatch::TestRequest#format (actionpack 8.1).
  it.each([
    [BROWSER_XML_FIRST, true, true],
    [BROWSER_XML_FIRST, false, true],
    ["text/html,application/xhtml+xml", true, true],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false, true],
    ["application/json", false, false],
    ["application/json", true, false],
    ["*/*", false, false],
    ["*/*", true, false],
    [null, false, true],
    [null, true, false],
    ["application/json, text/plain, */*", true, false],
  ])("reads Accept %j (xhr %j) as html: %j", (accept, xhr, expected) => {
    const headers: Record<string, string> = { ...(xhr ? XHR : {}), ...(accept ? { accept } : {}) };
    expect(formatIsHtml(request("/help", headers))).toBe(expected);
  });
});

describe("dashboard nav paths", () => {
  it("treats the help center and the other core and promotable prefixes as dashboard paths", () => {
    for (const path of ["/help", "/help/article/10-dealing-with-vat", "/dashboard", "/products/", "/checkout/form", "/Library"]) expect(dashboardPath(path)).toBe(true);
  });

  it("leaves storefront-like and bare checkout paths out, and matches /dashboard exactly", () => {
    for (const path of ["/checkout", "/dashboard/stats", "/about", "/helpful", ""]) expect(dashboardPath(path)).toBe(false);
  });

  it("promotes only the paths that name a promotable destination", () => {
    expect(navItemForPath("/checkout/discounts/new")).toBe("checkout");
    expect(navItemForPath("/dashboard/sales")).toBe("analytics");
    expect(navItemForPath("/wishlists")).toBe("library");
    expect(navItemForPath("/help")).toBeNull();
    expect(navItemForPath("/products")).toBeNull();
  });

  it("skips partial reloads, prefetches, impersonation, non-GET and other hosts", () => {
    const hosts = ["app.test.gumroad.com"];
    expect(dashboardNavRequest(request("/help"), hosts, false)).toBe(true);
    expect(dashboardNavRequest(request("/help", { "x-inertia-partial-data": "article" }), hosts, false)).toBe(false);
    expect(dashboardNavRequest(request("/help", { purpose: "prefetch" }), hosts, false)).toBe(false);
    expect(dashboardNavRequest(request("/help"), hosts, true)).toBe(false);
    expect(dashboardNavRequest(request("/help", {}, "POST"), hosts, false)).toBe(false);
    expect(dashboardNavRequest(request("/help"), ["gumroad.com"], false)).toBe(false);
  });
});

describe("deleteCookieHeader", () => {
  it("writes the line Rack's delete_set_cookie_header does, in its attribute order", () => {
    expect(deleteCookieHeader("current_seller_id", { domain: "gumroad.com" })).toBe(
      "current_seller_id=; domain=gumroad.com; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax",
    );
    expect(deleteCookieHeader("remember_user_token", { domain: "gumroad.com", httpOnly: true })).toBe(
      "remember_user_token=; domain=gumroad.com; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; httponly; samesite=lax",
    );
  });
});
