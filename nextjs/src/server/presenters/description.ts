// Link#plaintext_description and Link#html_safe_description for the markup this port can prove.
//
// Rails parses with libxml2's HTML4 parser (Loofah.fragment) and sanitizes with a Loofah scrubber, then
// Rinku links URLs. A description made of the tags below parses to the same tree in parse5, and the
// serialization rules for the HTML subset are the ones the golden corpus pins; anything else throws, so
// callers hand the request back to Rails instead of guessing.
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

import { NotPortedError } from "../page-props/not-ported.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

// Loofah::Elements::LINEBREAKERS (BLOCK_LEVEL plus br).
const BLOCK_LEVEL = new Set([
  "address", "article", "aside", "blockquote", "canvas", "center", "dd", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "isindex", "li", "main", "menu", "nav",
  "noframes", "noscript", "ol", "output", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "video",
]);

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
// Tags whose plain text is the concatenation of their children, as Loofah#to_text computes it.
const PLAINTEXT_TAGS = new Set(["p", "blockquote", "div", "figcaption", "figure", "hr", "li", "ol", "ul", "pre", ...HEADINGS, "br", "strong", "b", "em", "i", "u", "s", "code", "a", "span", "img"]);
// Tags html_safe_description serializes without the formatting newlines libxml2 adds around lists and divs,
// with no attributes to scrub.
const HTML_TAGS = new Set(["p", "strong", "b", "em", "u", "s", "br", "hr", "blockquote", "pre", "code", ...HEADINGS]);
const VOID_TAGS = new Set(["br", "hr"]);

// [[:space:]] in Ruby: Unicode White_Space.
export const RUBY_SPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const SQUISH = new RegExp(`${RUBY_SPACE}+`, "gu");
const EDGES = new RegExp(`^${RUBY_SPACE}+|${RUBY_SPACE}+$`, "gu");

// String#squish
export const squish = (text: string) => text.replace(EDGES, "").replace(SQUISH, " ");

const isElement = (node: Node): node is Element => "tagName" in node;

function walk(node: Node, visit: (element: Element) => string, text: (value: string) => string): string {
  if ("value" in node && node.nodeName === "#text") return text(node.value);
  if (node.nodeName === "#comment") return "";
  if (!isElement(node)) return "";
  return visit(node);
}

// Link#plaintext_description
export function plaintextDescription(description: string | null): string {
  if (description === null || description.trim() === "") return "";
  const fragment = parseFragment(description);
  const render = (node: Node): string =>
    walk(
      node,
      (element) => {
        if (!PLAINTEXT_TAGS.has(element.tagName)) throw new NotPortedError(`Link#plaintext_description with <${element.tagName}>`);
        if (element.tagName === "br") return "\n";
        const content = element.childNodes.map(render).join("");
        return BLOCK_LEVEL.has(element.tagName) ? `\n${content}\n` : content;
      },
      (value) => value,
    );
  return squish(fragment.childNodes.map(render).join(""));
}

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Rinku.auto_link(:all) links these.
const AUTO_LINKABLE = /:\/\/|www\.|@|mailto:/iu;

// Link#html_safe_description, for markup with no attributes, links or lists. null when the description is blank.
export function htmlSafeDescription(description: string | null): string | null {
  if (description === null || description === "") return null;
  if (description.trim() === "") return description;
  const fragment = parseFragment(description);
  const render = (node: Node): string =>
    walk(
      node,
      (element) => {
        if (!HTML_TAGS.has(element.tagName) || element.attrs.length > 0) throw new NotPortedError(`Link#html_safe_description with <${element.tagName}>`);
        if (VOID_TAGS.has(element.tagName)) return `<${element.tagName}>`;
        return `<${element.tagName}>${element.childNodes.map(render).join("")}</${element.tagName}>`;
      },
      (value) => {
        if (AUTO_LINKABLE.test(value)) throw new NotPortedError("Link#html_safe_description with a link in the text");
        return escapeText(value);
      },
    );
  return fragment.childNodes.map(render).join("");
}
