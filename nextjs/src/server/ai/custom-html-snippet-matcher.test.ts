import { describe, expect, it } from "vitest";

import { matchCustomHtmlSnippet } from "./custom-html-snippet-matcher.ts";

describe("matchCustomHtmlSnippet", () => {
  it("prefers the exact match when the snippet appears verbatim", () => {
    const result = matchCustomHtmlSnippet("<p>hello world</p>", "hello world");

    expect(result.occurrences).toBe(1);
    expect(result.matcher).toBe("hello world");
  });

  it("reports exact multi-matches as ambiguous without falling back to tolerant matching", () => {
    expect(matchCustomHtmlSnippet("<p>buy</p><p>buy</p>", "<p>buy</p>").occurrences).toBe(2);
  });

  it("matches a snippet whose plain space stands in for the page's non-breaking space", () => {
    const page = '<h1 class="headline">What habits?<span class="cursor"> </span>\n</h1>';
    const find = '<h1 class="headline">What habits?<span class="cursor"> </span>\n</h1>';

    const result = matchCustomHtmlSnippet(page, find);

    expect(result.occurrences).toBe(1);
    expect(page.replace(result.matcher, () => "replaced")).toBe("replaced");
  });

  it("matches in the other direction too (snippet has the NBSP, page has a plain space)", () => {
    expect(matchCustomHtmlSnippet("<p>a b</p>", "<p>a b</p>").occurrences).toBe(1);
  });

  it("treats an &nbsp; entity in the page as whitespace", () => {
    expect(matchCustomHtmlSnippet("<p>a&nbsp;b</p>", "<p>a b</p>").occurrences).toBe(1);
  });

  it("matches across differing whitespace runs (newline and indentation vs a single space)", () => {
    expect(matchCustomHtmlSnippet("<div>\n  <p>hi</p>\n</div>", "<div> <p>hi</p> </div>").occurrences).toBe(1);
  });

  it("does not invent a match where non-whitespace content differs", () => {
    expect(matchCustomHtmlSnippet("<p>hello world</p>", "<p>goodbye world</p>").occurrences).toBe(0);
  });

  it("keeps the snippet literal, so regex metacharacters never act as a pattern", () => {
    const page = "<p>Price: $10 (sale). Also literally $1X (sale)</p>";

    const result = matchCustomHtmlSnippet(page, "$10 (sale)");

    expect(result.occurrences).toBe(1);
    expect(page.replace(result.matcher, () => "$8 (sale)")).toContain("$8 (sale)");
    expect(page).toContain("$1X (sale)");
  });

  it("requires whitespace to be present on both sides, so a space in the snippet never matches nothing", () => {
    expect(matchCustomHtmlSnippet("<p>ab</p>", "<p>a b</p>").occurrences).toBe(0);
  });

  it("prefers a unique exact occurrence even when a whitespace variant of it also exists", () => {
    const page = "<p>a b</p><p>a b</p>";

    const result = matchCustomHtmlSnippet(page, "<p>a b</p>");

    expect(result.occurrences).toBe(1);
    expect(page.replace(result.matcher, () => "X")).toBe("<p>a b</p>X");
  });

  it("counts tolerant multi-matches as ambiguous", () => {
    expect(matchCustomHtmlSnippet("<p>a b</p><p>a b</p>", "<p>a b</p>").occurrences).toBe(2);
  });

  it("replaces exactly the tolerant match, leaving the rest of the page untouched", () => {
    const page = "<section><h1>Hi there</h1><p>keep me</p></section>";

    const result = matchCustomHtmlSnippet(page, "<h1>Hi there</h1>");

    expect(page.replace(result.matcher, () => "<h1>New</h1>")).toBe("<section><h1>New</h1><p>keep me</p></section>");
  });
});
