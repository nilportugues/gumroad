import { describe, expect, it } from "vitest";

import { parseQuery, toQuery } from "../controllers/rails-query.ts";
import { secureHeaders } from "../infra/secure-headers.ts";
import { matchPagePath, PAGES } from "./pages.ts";

describe("action options of the WS-55 pages", () => {
  it("opts the public developer pages out of the CSP header, as PublicController does", () => {
    for (const pattern of ["/api", "/ping", "/charge", "/license-key-lookup", "/widgets"]) expect(PAGES[pattern]?.options).toMatchObject({ optOutOfCsp: true });
    expect(Object.keys(secureHeaders({ optOutOfCsp: true }))).not.toContain("content-security-policy");
    expect(Object.keys(secureHeaders())).toContain("content-security-policy");
  });

  it("guards the seller pages and nothing else", () => {
    for (const pattern of ["/pages", "/pages/new", "/pages/:slug/edit"]) expect(PAGES[pattern]?.guard).toBeTypeOf("function");
    for (const pattern of ["/blog", "/ping", "/:username/p/:slug"]) expect(PAGES[pattern]?.guard).toBeUndefined();
  });
});

describe("matchPagePath", () => {
  it("matches the blog post before the generic post page, as config/routes.rb orders them", () => {
    expect(matchPagePath("/blog/p/hello")).toEqual({ pattern: "/blog/p/:slug", params: { slug: "hello" } });
    expect(matchPagePath("/jane/p/hello")).toEqual({ pattern: "/:username/p/:slug", params: { username: "jane", slug: "hello" } });
  });

  it("matches the page editor by slug", () => {
    expect(matchPagePath("/pages/about/edit")).toEqual({ pattern: "/pages/:slug/edit", params: { slug: "about" } });
    expect(matchPagePath("/pages/new")?.pattern).toBe("/pages/new");
  });
});

describe("Rails query strings", () => {
  it("sorts keys, nests hashes, lists arrays and escapes like CGI.escape", () => {
    const query = parseQuery("?purchase_id=abc&b=x+y&a[]=2&a[]=1&c[d]=e~f&c[g]=h&i=j&i=k");
    expect(toQuery(query).join("&")).toBe("a%5B%5D=2&a%5B%5D=1&b=x+y&c%5Bd%5D=e~f&c%5Bg%5D=h&i=k&purchase_id=abc");
  });
});
