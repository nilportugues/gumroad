import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { assertFlatQuery, cgiEscape, cgiParse, cgiUnescape, requestFormat, safeRedirectPath } from "./rails-params.ts";
import { railsRequest } from "./rails-request.ts";

const request = (path = "/login", headers: Record<string, string> = {}) =>
  railsRequest(new Request(`http://app.test.gumroad.com:31337${path}`, { headers: { host: "app.test.gumroad.com:31337", ...headers } }));
const safe = (input: string | null, options: { allowSubdomainHost?: boolean } = {}) =>
  safeRedirectPath(input, request(), { rootDomain: "test.gumroad.com:31337", ...options });

describe("CGI escaping", () => {
  it("escapes like CGI.escape", () => {
    expect(cgiEscape("/two-factor?next=/dashboard")).toBe("%2Ftwo-factor%3Fnext%3D%2Fdashboard");
    expect(cgiEscape("http://host:3000/a b~c*d(e)!'")).toBe("http%3A%2F%2Fhost%3A3000%2Fa+b~c%2Ad%28e%29%21%27");
    expect(cgiEscape("é")).toBe("%C3%A9");
  });

  it("unescapes like CGI.unescape", () => {
    expect(cgiUnescape("%2Fdashboard+x%2B%25zz%")).toBe("/dashboard x+%zz%");
    expect(cgiUnescape("%C3%A9")).toBe("é");
  });

  it("hands back a run of bytes that is not UTF-8", () => {
    expect(() => cgiUnescape("%FF")).toThrow(HandBackToRails);
    expect(cgiUnescape("é+%C3%A9")).toBe("é é");
  });

  it("parses like CGI.parse", () => {
    expect([...cgiParse("client_id=a%20b&scope=x;scope=y&flag")]).toEqual([
      ["client_id", ["a b"]],
      ["scope", ["x", "y"]],
      ["flag", [null]],
    ]);
  });
});

describe("assertFlatQuery", () => {
  it("lets flat keys through and hands back array and hash params", () => {
    expect(() => assertFlatQuery("next=%2Fa%5B0%5D&email=a")).not.toThrow();
    expect(() => assertFlatQuery("next[]=a")).toThrow(HandBackToRails);
    expect(() => assertFlatQuery("a=1&next%5Bx%5D=a")).toThrow(HandBackToRails);
  });
});

describe("requestFormat", () => {
  it("reads html from a plain request and from the browser Accept lists Rails ignores", () => {
    expect(requestFormat(request())).toBe("html");
    expect(requestFormat(request("/login", { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }))).toBe("html");
  });

  it("reads json from an Accept header that names it", () => {
    expect(requestFormat(request("/login", { accept: "application/json" }))).toBe("json");
    expect(requestFormat(request("/login", { accept: "application/json, text/plain" }))).toBe("json");
    // A trailing "*/*" makes Rails ignore the header altogether.
    expect(requestFormat(request("/login", { accept: "application/json, text/plain, */*" }))).toBe("html");
  });

  it("reads the first of an Inertia visit's types", () => {
    expect(requestFormat(request("/login", { accept: "text/html, application/xhtml+xml", "x-requested-with": "XMLHttpRequest" }))).toBe("html");
  });

  it("hands back lists it cannot rank like Rails does", () => {
    expect(() => requestFormat(request("/login", { accept: "text/xml, text/html" }))).toThrow(HandBackToRails);
    expect(requestFormat(request("/login", { accept: "image/png" }))).toBe("other");
    expect(requestFormat(request("/login", { "x-requested-with": "XMLHttpRequest", accept: "" }))).toBe("other");
  });
});

type GoldenCase = { path: string | null; allow_subdomain_host: boolean; value?: string; raises?: string };
const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "__fixtures__/safe-redirect-path.golden.json"), "utf8")) as {
  safe_redirect_path: GoldenCase[];
  cgi_escape: Record<string, string>;
  cgi_unescape: Record<string, string>;
};

describe("against Ruby (__fixtures__/generate-safe-redirect-golden.rb)", () => {
  it("escapes and unescapes like CGI", () => {
    for (const [input, expected] of Object.entries(golden.cgi_escape)) expect(cgiEscape(input), JSON.stringify(input)).toBe(expected);
    for (const [input, expected] of Object.entries(golden.cgi_unescape)) expect(cgiUnescape(input), JSON.stringify(input)).toBe(expected);
  });

  it("answers SafeRedirectPathService the way it does, or hands the request back", () => {
    let answered = 0;
    for (const { path: input, allow_subdomain_host: allowSubdomainHost, value, raises } of golden.safe_redirect_path) {
      const label = `${JSON.stringify(input)} (subdomain host ${allowSubdomainHost ? "allowed" : "refused"})`;
      let actual: string;
      try {
        actual = safe(input, { allowSubdomainHost });
      } catch (error) {
        expect(error, label).toBeInstanceOf(HandBackToRails);
        continue;
      }
      // Ruby raising is a 500 the port must not turn into an answer.
      expect(raises, label).toBeUndefined();
      expect(actual, label).toBe(value);
      answered += 1;
    }
    // The cases a visitor can send in a real flow are answered, not handed back.
    expect(answered).toBeGreaterThan(golden.safe_redirect_path.length * 0.8);
  });

  it("hands back the inputs Ruby raises on", () => {
    for (const input of ["javascript:alert(1)", "mailto:a@example.com", "a:b", "#"]) expect(() => safe(input), input).toThrow(HandBackToRails);
  });
});
