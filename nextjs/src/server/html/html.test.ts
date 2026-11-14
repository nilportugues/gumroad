import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checks } from "./__fixtures__/html-checks.ts";
import type { HtmlGolden } from "./__fixtures__/html-golden.ts";
import { parseHtmlDocument } from "./libxml2-parser.ts";
import { UnsupportedHtmlError } from "./libxml2-tree.ts";
import { cgiUnescapeHtml } from "./sanitizer.ts";

const golden = JSON.parse(readFileSync(new URL("__fixtures__/html.golden.json", import.meta.url), "utf8")) as HtmlGolden;

describe("HTML helpers against the gems' output on seeded random markup", () => {
  for (const check of checks) {
    it(`matches ${check.name} on all ${golden.cases.length} cases`, () => {
      for (const [index, c] of golden.cases.entries()) {
        expect([index, check.input(c), check.actual(c)]).toEqual([index, check.input(c), check.expected(c)]);
      }
    });
  }
});

describe("what the port refuses", () => {
  it("refuses nesting deeper than libxml2's limit, where Nokogiri raises", () => {
    expect(() => parseHtmlDocument("<div>".repeat(300))).toThrow(UnsupportedHtmlError);
  });

  it("raises on a surrogate character reference, as the gsub after CGI.unescapeHTML does", () => {
    expect(() => cgiUnescapeHtml("&#xD800;")).toThrow("invalid byte sequence in UTF-8");
  });
});
