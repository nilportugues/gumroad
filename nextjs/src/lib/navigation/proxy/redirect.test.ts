import { describe, expect, it } from "vitest";

import { redirectLocation } from "./redirect";
import { compileRouteTable } from "./route-table";

const routes = compileRouteTable({
  "/careers/:slug": { flag: "f", redirect: "/gumclaw" },
  "/settings/profile": { flag: "f", redirect: "/profile", redirectQuery: "keep" },
  "/products/:id": { flag: "f", redirect: "/l/%{id}", redirectExcept: { id: ["new"] } },
  "/products/:id/:code": { flag: "f", redirect: "/l/%{id}/%{code}", redirectExcept: { code: ["edit"] } },
  "/subscriptions/:id/edit_card": { flag: "f", redirect: "/subscriptions/%{id}/manage", redirectQuery: "to_query" },
  "discover:/animation(*path)": { flag: "f", redirectReplace: ["animation", "3d"] },
});

function locate(url: string): string | null {
  const parsed = new URL(url, "https://gumroad.com");
  const route = routes.find((candidate) => candidate.regexp.test(parsed.pathname));
  if (!route) throw new Error(`no route for ${url}`);
  return redirectLocation(route, parsed);
}

describe("redirectLocation", () => {
  it("drops the query string of a plain redirect", () => {
    expect(locate("/careers/designer?ref=board")).toBe("/gumclaw");
  });

  it("keeps the query string when the route appends it", () => {
    expect(locate("/settings/profile?section=bio&x=a+b")).toBe("/profile?section=bio&x=a+b");
    expect(locate("/settings/profile?")).toBe("/profile");
  });

  it("writes path parameters back escaped as Rails does", () => {
    expect(locate("/products/a%20b")).toBe("/l/a%20b");
    expect(locate("/products/a%2Fb")).toBe("/l/a/b");
    expect(locate("/products/a+b")).toBe("/l/a+b");
    expect(locate("/products/a%25b")).toBe("/l/a%25b");
    expect(locate("/products/caf%C3%A9")).toBe("/l/caf%C3%A9");
    expect(locate("/products/a%3Fb%23c")).toBe("/l/a%3Fb%23c");
    expect(locate("/products/a%26b%3Dc")).toBe("/l/a&b=c");
    expect(locate("/products/a%21%24%27%28%29%2A%2C%3B%7E")).toBe("/l/a!$'()*,;~");
    expect(locate("/products/abc/OFFER")).toBe("/l/abc/OFFER");
  });

  it("leaves a parameter value that an earlier Rails route owns to Rails", () => {
    expect(locate("/products/new")).toBeNull();
    expect(locate("/products/abc/edit")).toBeNull();
  });

  it("leaves malformed percent-encoding to Rails", () => {
    expect(locate("/products/%FF")).toBeNull();
  });

  describe("rebuilding the query like to_query", () => {
    it("sorts the pairs and re-escapes them", () => {
      expect(locate("/subscriptions/abc/edit_card?token=t&a=1")).toBe("/subscriptions/abc/manage?a=1&token=t");
      expect(locate("/subscriptions/abc/edit_card?x=a%20b%26c")).toBe("/subscriptions/abc/manage?x=a+b%26c");
      expect(locate("/subscriptions/abc/edit_card?x=~*.-_!'()")).toBe(
        "/subscriptions/abc/manage?x=~%2A.-_%21%27%28%29",
      );
      expect(locate("/subscriptions/abc/edit_card?x=caf%C3%A9")).toBe("/subscriptions/abc/manage?x=caf%C3%A9");
      expect(locate("/subscriptions/abc/edit_card?x=1;y=2")).toBe("/subscriptions/abc/manage?x=1%3By%3D2");
    });

    it("keeps an empty value, drops a key with no value and lets the last duplicate win", () => {
      expect(locate("/subscriptions/abc/edit_card?x=")).toBe("/subscriptions/abc/manage?x=");
      expect(locate("/subscriptions/abc/edit_card?x")).toBe("/subscriptions/abc/manage");
      expect(locate("/subscriptions/abc/edit_card?x=1&x=2")).toBe("/subscriptions/abc/manage?x=2");
      expect(locate("/subscriptions/abc/edit_card?a=1&&b=2")).toBe("/subscriptions/abc/manage?a=1&b=2");
    });

    it("leaves a nested query to Rails", () => {
      expect(locate("/subscriptions/abc/edit_card?a[]=1")).toBeNull();
      expect(locate("/subscriptions/abc/edit_card?a%5Bb%5D=1")).toBeNull();
    });
  });

  it("replaces the first occurrence in the path and query for the animation redirect", () => {
    expect(locate("/animation")).toBe("/3d");
    expect(locate("/animation/scene?x=1")).toBe("/3d/scene?x=1");
    expect(locate("/animationfoo")).toBe("/3dfoo");
    expect(locate("/animation/a%20b?q=a+b")).toBe("/3d/a%20b?q=a+b");
  });
});
