// What each html.golden.json case pins, as [port output, Ruby output] pairs, shared by html.test.ts
// and fuzz-html.ts.
import { parseHtmlDocument } from "../libxml2-parser.ts";
import { fragmentToHtml, html4Fragment } from "../loofah.ts";
import { autoLink } from "../rinku.ts";
import { allowedUri, sanitize, stripTags } from "../sanitizer.ts";
import { simpleFormat } from "../text-helper.ts";
import { dumpDocument, type HtmlCase, type Outcome } from "./html-golden.ts";

export type Check = { name: string; input: (c: HtmlCase) => string; actual: (c: HtmlCase) => unknown; expected: (c: HtmlCase) => unknown };

// The calls the mailer views make (see generate-html-golden.rb).
const RECAP_TAGS = ["ul", "ol", "li", "strong", "b", "em", "a"];
const RECAP_ATTRIBUTES = ["href", "target", "rel"];
const COMMENT_LINK_ATTRS = 'target="_blank" rel="noopener noreferrer nofollow"';
const RECAP_LINK_ATTRS = 'target="_blank" rel="nofollow"';

const outcome = (f: () => string): Outcome => {
  try {
    return { ok: f() };
  } catch (error) {
    return { error: String(error) };
  }
};

export const checks: Check[] = [
  { name: "parse", input: (c) => c.document, actual: (c) => dumpDocument(parseHtmlDocument(c.document)), expected: (c) => c.parse },
  { name: "fragment_html", input: (c) => c.fragment, actual: (c) => fragmentToHtml(html4Fragment(c.fragment)), expected: (c) => c.fragment_html },
  { name: "strip_tags", input: (c) => c.fragment, actual: (c) => stripTags(c.fragment), expected: (c) => c.strip_tags },
  { name: "sanitize", input: (c) => c.fragment, actual: (c) => sanitize(c.fragment), expected: (c) => c.sanitize },
  {
    name: "sanitize_recap",
    input: (c) => c.fragment,
    actual: (c) => sanitize(c.fragment, { tags: RECAP_TAGS, attributes: RECAP_ATTRIBUTES }),
    expected: (c) => c.sanitize_recap,
  },
  { name: "allowed_uri", input: (c) => c.uri, actual: (c) => outcome(() => String(allowedUri(c.uri))), expected: (c) => c.allowed_uri },
  { name: "href", input: (c) => c.href_fragment, actual: (c) => outcome(() => sanitize(c.href_fragment)), expected: (c) => c.href },
  { name: "simple_format", input: (c) => c.simple_format_input, actual: (c) => simpleFormat(c.simple_format_input), expected: (c) => c.simple_format },
  { name: "auto_link", input: (c) => c.links, actual: (c) => outcome(() => autoLink(c.links, COMMENT_LINK_ATTRS)), expected: (c) => c.auto_link },
  {
    name: "comment_body",
    input: (c) => c.fragment + c.links,
    actual: (c) => outcome(() => autoLink(stripTags(c.fragment + c.links), COMMENT_LINK_ATTRS)),
    expected: (c) => c.comment_body,
  },
  {
    name: "recap_summary",
    input: (c) => c.links + c.fragment,
    actual: (c) => outcome(() => sanitize(autoLink(c.links + c.fragment, RECAP_LINK_ATTRS), { tags: RECAP_TAGS, attributes: RECAP_ATTRIBUTES })),
    expected: (c) => c.recap_summary,
  },
];
