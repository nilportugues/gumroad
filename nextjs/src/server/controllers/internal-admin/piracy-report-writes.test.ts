import { describe, expect, it } from "vitest";

import { NotPortedError } from "../../models/user.ts";
import type { AdminRequest } from "./base.ts";
import { descriptionFact } from "./piracy-report-detail.ts";
import { normalizeUrl, parseHttpUrl, parseIsoDate, screeningInput } from "./piracy-report-writes.ts";
import { findAdminRoute } from "./registry.ts";

const normalized = (url: string) => normalizeUrl(parseHttpUrl(url)!);
const input = (params: Record<string, unknown>) => screeningInput({ params } as unknown as AdminRequest);
const passed = { passed: true, reason: "Matches the product." };
const allChecks = { page_offers_work: passed, not_other_authorized_use: passed, not_licensee_or_related_party: passed };

describe("parseHttpUrl", () => {
  it("reads the host, port, path and query of an http URL", () => {
    expect(parseHttpUrl("https://Example.net:8443/a/b?x=1#frag")).toEqual({ scheme: "https", host: "Example.net", port: 8443, path: "/a/b", query: "x=1" });
  });

  it("answers null for text that is not an http URL under any reading", () => {
    for (const text of ["", "example.net", "ftp://example.net/x", "not a url", "//example.net/x"]) expect(parseHttpUrl(text)).toBeNull();
  });

  it("hands back a URL that starts like one but falls outside the pattern", () => {
    for (const text of ["http://user@example.net/", "http://[::1]/", "http://example.net/a b", "http://example.net/100%"]) expect(() => parseHttpUrl(text)).toThrow(NotPortedError);
  });
});

describe("normalizeUrl", () => {
  it("makes two spellings of the same page collide", () => {
    expect(normalized("HTTP://www.Example.net/course/?b=2&a=1#top")).toBe(normalized("https://example.net/course?a=1&b=2"));
    expect(normalized("https://example.net")).toBe("example.net/");
  });

  it("keeps a port that is not the default of the scheme", () => {
    expect(normalized("https://example.net:8443/x")).toBe("example.net:8443/x");
    expect(normalized("https://example.net:443/x")).toBe("example.net/x");
  });

  it("drops an empty query and trailing separators", () => {
    expect(normalized("https://example.net/x?")).toBe("example.net/x");
    expect(normalized("https://example.net/x?a=1&")).toBe("example.net/x?a=1");
  });
});

describe("parseIsoDate", () => {
  it("accepts a real calendar date only", () => {
    expect(parseIsoDate("2026-02-28")).toBe("2026-02-28");
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("2026-2-3")).toBeNull();
    expect(parseIsoDate("2026-02-28\n")).toBeNull();
  });
});

describe("descriptionFact", () => {
  it("strips ordinary tags and squishes whitespace", () => {
    expect(descriptionFact("<p>Learn   <strong>design</strong></p>\n<p>fast</p>")).toBe("Learn design fast");
  });

  it("truncates to 2000 characters with an ellipsis", () => {
    const result = descriptionFact("a".repeat(2500));
    expect(result).toHaveLength(2000);
    expect(result.endsWith("...")).toBe(true);
  });

  it("hands back markup and entities the sanitizer treats specially", () => {
    for (const text of ["<script>x</script>", "Fish &amp; chips", "1 < 2"]) expect(() => descriptionFact(text)).toThrow(NotPortedError);
  });
});

describe("screeningInput", () => {
  it("accepts a fail verdict with one failed check", () => {
    const result = input({ verdict: "fail", checks: { page_offers_work: { passed: false, reason: " Different course. " } } });
    expect(result.errors).toEqual([]);
    expect(result.checks).toEqual({ page_offers_work: { passed: false, reason: "Different course." } });
  });

  it("reads the string forms of booleans and nothing else", () => {
    const result = input({ verdict: "review", checks: { page_offers_work: { passed: "true", reason: "r" }, not_other_authorized_use: { passed: "maybe", reason: "r" } } });
    expect(result.errors).toEqual(["check not_other_authorized_use passed must be true or false"]);
  });

  it("lists every problem of a malformed request", () => {
    expect(input({ verdict: "approve", checks: { page_offers_work: "yes", extra: {} } }).errors).toEqual([
      "verdict must be pass, fail or review",
      "unknown check extra",
      "check page_offers_work must be an object",
    ]);
    expect(input({ verdict: "review" }).errors).toEqual(["at least one check is required"]);
  });

  it("requires every check to pass for a pass verdict", () => {
    expect(input({ verdict: "pass", checks: { page_offers_work: passed } }).errors).toEqual([
      "a pass verdict needs every check: missing not_other_authorized_use, not_licensee_or_related_party",
    ]);
    expect(input({ verdict: "pass", checks: allChecks }).errors).toEqual([]);
  });

  it("needs a reason within the limit on each check", () => {
    const errors = input({ verdict: "review", checks: { page_offers_work: { passed: true, reason: "  " }, not_other_authorized_use: { passed: true, reason: "x".repeat(281) } } }).errors;
    expect(errors).toEqual(["check page_offers_work needs a reason", "check not_other_authorized_use reason is too long"]);
  });
});

describe("piracy report routes", () => {
  it("serves the show, create and the four transitions", () => {
    expect(findAdminRoute("GET", "/internal/admin/piracy_reports/abc_-1")).not.toBeNull();
    expect(findAdminRoute("POST", "/api/internal/admin/piracy_reports")).not.toBeNull();
    for (const action of ["start_screening", "screen", "counter_notice", "resolve"]) expect(findAdminRoute("POST", `/internal/admin/piracy_reports/abc/${action}`)).not.toBeNull();
  });
});
