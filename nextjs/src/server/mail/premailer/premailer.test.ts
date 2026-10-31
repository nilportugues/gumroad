import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { unwrapLayers } from "../stylesheet.ts";
import { parseHtml, UnsupportedHtmlError } from "./html.ts";
import { premailerRails } from "./premailer.ts";
import { search } from "./selector.ts";

type PremailerCase = { name: string; kind: "message" | "premailer"; rendered_html: string; css?: string; text_part: string; html_part: string };
const golden = JSON.parse(readFileSync(new URL("../__fixtures__/mail.golden.json", import.meta.url), "utf8")) as { cases: (PremailerCase | { kind: "enqueue" })[] };
const emailCss = readFileSync(new URL("../__fixtures__/email.css", import.meta.url), "utf8");
const CSS_HREF = "https://assets.gumroad.com/vite/assets/email-golden.css";
const EXTRA_HREF = "https://assets.gumroad.com/vite/assets/extra.css";

describe("premailer-rails", () => {
  const cases = golden.cases.filter((x): x is PremailerCase => x.kind === "message" || x.kind === "premailer");
  for (const c of cases) {
    it(`produces ${c.name}'s text and html parts as premailer-rails does`, () => {
      const result = premailerRails(c.rendered_html, (href) => {
        if (href === EXTRA_HREF && c.css !== undefined) return unwrapLayers(c.css);
        expect(href).toBe(CSS_HREF);
        return unwrapLayers(emailCss);
      });
      expect(result.text).toBe(c.text_part);
      expect(result.html).toBe(c.html_part);
    });
  }

  it("refuses markup libxml2 would restructure instead of guessing", () => {
    const wrap = (body: string) =>
      `<!DOCTYPE html><html><head><meta content="text/html; charset=UTF-8" http-equiv="Content-Type"></head><body>${body}</body></html>`;
    expect(() => premailerRails(wrap("<p><div>x</div></p>"), () => "")).toThrow(UnsupportedHtmlError);
    expect(() => premailerRails(wrap("<b><p>x</p></b>"), () => "")).toThrow(UnsupportedHtmlError);
    expect(() => premailerRails(wrap("<div>x"), () => "")).toThrow(UnsupportedHtmlError);
    expect(() => premailerRails(wrap("&copy;"), () => "")).toThrow(UnsupportedHtmlError);
  });
});

describe("Nokogiri CSS search", () => {
  const doc = parseHtml(
    `<!DOCTYPE html><html><head><title>x</title></head><body>
<div class="a  b" id="m" role="alert" data-x="foo-bar baz"><p>1</p><p class="b">2</p><span>3</span><p></p></div>
<ul><li>a</li><li class="x">b</li><li>c</li><li>d</li><li>e</li></ul>
<a href="https://x.com/y" lang="en-US">l</a><img src="i.png" alt=""><table><tr><td>1</td><td>2</td></tr></table>
</body></html>`,
  );
  const names = (selector: string) => {
    const result = search(doc, selector);
    return result === "skip" ? "skip" : result.map((el) => `${el.name}${el.attributes.find((a) => a.name === "class")?.value ?? ""}`).join(" ");
  };

  // Expected values recorded from Nokogiri 1.19.4 on the same document.
  it.each([
    [":root", "html"],
    [":host", "skip"],
    [":is(p)", "skip"],
    ["::before", "skip"],
    [":before", "skip"],
    ["*|p", "skip"],
    ["li:NTH-CHILD(2)", "skip"],
    [":empty", "p img"],
    ["li:nth-child(odd)", "li li li"],
    ["li:nth-child(-n+3)", "li lix li"],
    ["li:nth-child(n+3)", "li li li"],
    ["li:nth-child( 2n + 1 )", "li li li"],
    ["li:nth-last-child(2)", "li"],
    ["div :not(.b)", "p span p"],
    ["li:not(:first-child):not(:last-child)", "lix li li"],
    ["[lang|=en]", "a"],
    ["[data-x~=baz]", "diva  b"],
    ["[class='a  b']", "diva  b"],
    ["DIV", ""],
    ["#m > p + p", "pb"],
    ["#m p ~ span", "span"],
    ["ul > li:nth-child(2) + li", "li"],
    ["*[@id=m]", "diva  b"],
    [".a.b > p.b", "pb"],
    ["td:nth-child(2)", "td"],
  ])("%s", (selector, expected) => {
    expect(names(selector)).toBe(expected);
  });
});
