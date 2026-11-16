// Loofah 2.25's HTML4 fragment (Nokogiri::HTML4::DocumentFragment without a context node) and the
// bottom-up scrub traversal rails-html-sanitizer drives.
import { parseHtmlDocument } from "./libxml2-parser.ts";
import { type FragmentNode, type HtmlNode, serializeChildren } from "./libxml2-tree.ts";

// Ruby's /^\s*?<body/i: `^` matches after every "\n" (not "\r"), and \s is ASCII whitespace.
const BODY_AT_LINE_START = /[ \t\r\n\f\v]*<body/iyu;
function startsLineWithBody(input: string): boolean {
  const lineStarts = [0];
  for (let i = input.indexOf("\n"); i !== -1; i = input.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  return lineStarts.some((at) => {
    BODY_AT_LINE_START.lastIndex = at;
    return BODY_AT_LINE_START.test(input);
  });
}

// Loofah.html4_fragment(input): the input parsed after "<html><body>", then either the body's
// children or, when a line starts with <body, the body element itself moved into the fragment.
export function html4Fragment(input: string): FragmentNode {
  const doc = parseHtmlDocument(`<html><body>${input}`);
  // The XPath matches every <html><body>: after a stray </html> the parser can start a second
  // <html> at the top level, and a second <body> in either.
  const childElements = (parent: { children: HtmlNode[] }, name: string) => parent.children.filter((n) => n.type === "element" && n.name === name);
  const bodies = childElements(doc, "html").flatMap((html) => (html.type === "element" ? childElements(html, "body") : []));
  const fragment: FragmentNode = { type: "fragment", children: [], parent: null };
  const moved: HtmlNode[] = startsLineWithBody(input) ? bodies : bodies.flatMap((body) => (body.type === "element" ? body.children : []));
  for (const node of [...moved]) {
    node.parent = fragment;
    fragment.children.push(node);
    // Node#add_child_node_and_reparent_attrs re-sets each prefixed attribute, which moves it last
    // and gives a valueless one an empty value.
    if (node.type !== "element") continue;
    const prefixed = node.attributes.filter((a) => a.name.includes(":"));
    node.attributes = [...node.attributes.filter((a) => !a.name.includes(":")), ...prefixed.map((a) => ({ name: a.name, value: a.value ?? "" }))];
  }
  return fragment;
}

// DocumentFragment#to_html
export const fragmentToHtml = (fragment: FragmentNode): string => serializeChildren(fragment);

// Loofah::Scrubber#traverse bottom up, over a snapshot of each node's children, as
// NodeSet#scrub! does for the fragment's own children.
export function scrubBottomUp(fragment: FragmentNode, scrub: (node: HtmlNode) => void): void {
  const visit = (node: HtmlNode) => {
    if (node.type === "element") for (const child of [...node.children]) visit(child);
    scrub(node);
  };
  for (const child of [...fragment.children]) visit(child);
}
