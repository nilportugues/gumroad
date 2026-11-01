// libxml2 2.13.9's HTML document tree as Nokogiri 1.19 exposes it, the Nokogiri calls premailer and
// Loofah make on it, and the serializer: htmlNodeDumpFormatOutput with format on (HTMLtree.c),
// with Nokogiri's libxml2 patches applied.
import { HTML40_ELEMENTS } from "./libxml2-tables.ts";

export class UnsupportedHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedHtmlError";
  }
}

export type Attribute = { name: string; value: string | null };

export type ElementNode = {
  type: "element";
  name: string;
  attributes: Attribute[];
  children: HtmlNode[];
  parent: ParentNode | null;
};
export type TextNode = { type: "text"; content: string; parent: ParentNode | null };
// What libxml2 makes of <script> and <style> content (XML_CDATA_SECTION_NODE), dumped verbatim.
export type CdataNode = { type: "cdata"; content: string; parent: ParentNode | null };
export type CommentNode = { type: "comment"; content: string; parent: ParentNode | null };
export type PiNode = { type: "pi"; name: string; content: string | null; parent: ParentNode | null };
export type Dtd = { name: string | null; externalId: string | null; systemId: string | null };
export type DocumentNode = { type: "document"; dtd: Dtd | null; children: HtmlNode[]; parent: null };
// Nokogiri::XML::DocumentFragment: a parent without a name.
export type FragmentNode = { type: "fragment"; children: HtmlNode[]; parent: null };
export type HtmlNode = ElementNode | TextNode | CdataNode | CommentNode | PiNode;
export type ParentNode = ElementNode | DocumentNode | FragmentNode;

type ElementInfo = { empty: boolean; inline: boolean; saveEndTag: boolean };
const INFO = new Map<string, ElementInfo>(HTML40_ELEMENTS.map((e) => [e.name, { empty: e.empty !== 0, inline: e.isinline !== 0, saveEndTag: e.saveEndTag !== 0 }]));
// htmlTagLookup (case-insensitive bsearch).
const lookup = (name: string) => INFO.get(name.toLowerCase());

export const BOOLEAN_ATTRIBUTES = new Set(["checked", "compact", "declare", "defer", "disabled", "ismap", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly", "selected"]);

export function isEmptyTag(name: string): boolean {
  return lookup(name)?.empty ?? false;
}

export function createElement(name: string, attributes: Attribute[] = []): ElementNode {
  return { type: "element", name, attributes, children: [], parent: null };
}

export function appendChild(parent: ParentNode, child: HtmlNode): void {
  child.parent = parent;
  parent.children.push(child);
}

// ---------------------------------------------------------------------------------------------
// Tree helpers (Nokogiri's API, as premailer and Loofah use it)

export function getAttribute(element: ElementNode, name: string): string | null | undefined {
  const attr = element.attributes.find((a) => a.name === name);
  return attr === undefined ? undefined : attr.value;
}

// Node#[]= appends a new attribute, or replaces the value in place.
export function setAttribute(element: ElementNode, name: string, value: string): void {
  const attr = element.attributes.find((a) => a.name === name);
  if (attr) attr.value = value;
  else element.attributes.push({ name, value });
}

export function removeAttribute(element: ElementNode, name: string): void {
  element.attributes = element.attributes.filter((a) => a.name !== name);
}

export function removeNode(node: HtmlNode): void {
  const parent = node.parent;
  if (!parent) return;
  parent.children = parent.children.filter((c) => c !== node);
  node.parent = null;
}

// Node#add_previous_sibling for each of `nodes`, in order.
export function insertBefore(reference: HtmlNode, nodes: HtmlNode[]): void {
  const parent = reference.parent;
  if (!parent) return;
  for (const node of nodes) {
    removeNode(node);
    const index = parent.children.indexOf(reference);
    parent.children.splice(index, 0, node);
    node.parent = parent;
  }
}

// Document order, as an XPath `//*` returns it.
export function allElements(root: ParentNode): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (node: ParentNode) => {
    for (const child of node.children) {
      if (child.type === "element") {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

export function findElement(root: ParentNode, name: string): ElementNode | undefined {
  return allElements(root).find((e) => e.name === name);
}

// Node#content / #inner_text: the text and CDATA below the node, in document order.
export function textContent(node: HtmlNode | ParentNode): string {
  if (node.type === "text" || node.type === "cdata") return node.content;
  if (node.type === "comment" || node.type === "pi") return "";
  return node.children.map((c) => (c.type === "comment" || c.type === "pi" ? "" : textContent(c))).join("");
}

// ---------------------------------------------------------------------------------------------
// Serialization

// xmlEncodeEntitiesInternal for an HTML document, as Nokogiri patches it (no server-side-include
// or "&{...}" script-macro cases): control characters other than tab, newline and carriage return
// are dropped.
export function encodeEntities(value: string): string {
  return value.replace(/[<>&\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ""));
}

// xmlURIEscapeStr(value, "\"#$%&+,/:;<=>?@[\\]^`{|}")
function escapeUri(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(byte);
    if (byte < 0x80 && /[A-Za-z0-9\-_.!~*'()"#$%&+,/:;<=>?@[\\\]^`{|}]/u.test(c)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// xmlOutputBufferWriteQuotedString
function quote(value: string): string {
  if (value.includes('"')) {
    if (value.includes("'")) return `"${value.replaceAll('"', "&quot;")}"`;
    return `'${value}'`;
  }
  return `"${value}"`;
}

// htmlAttrDumpOutput
function serializeAttribute(element: ElementNode, attr: Attribute): string {
  if (attr.value === null || BOOLEAN_ATTRIBUTES.has(attr.name)) return ` ${attr.name}`;
  const value = encodeEntities(attr.value);
  const name = attr.name.toLowerCase();
  const isUri = name === "href" || name === "action" || name === "src" || (name === "name" && element.name.toLowerCase() === "a");
  return ` ${attr.name}=${quote(isUri ? escapeUri(value.replace(/^[ \t\n\r]+/u, "")) : value)}`;
}

const parentName = (parent: ParentNode | null) => (parent?.type === "element" ? parent.name : null);
// The newline after a block element followed by a non-text sibling, unless the parent's name
// starts with "p" (p, pre, param) or the parent has no name (a document or fragment).
const newlineAfter = (node: HtmlNode, parent: ParentNode | null, next: HtmlNode | undefined) => {
  if (node.type !== "element" || next === undefined || next.type === "text") return false;
  const info = lookup(node.name);
  const name = parentName(parent);
  return info !== undefined && !info.inline && name !== null && name[0] !== "p";
};

// htmlNodeDumpFormatOutput for `node`, whose parent is `parent`; `next` is its next sibling.
function serializeNode(node: HtmlNode, parent: ParentNode | null, next: HtmlNode | undefined, out: string[]): void {
  switch (node.type) {
    case "text": {
      const raw = parent?.type === "element" && ["script", "style"].includes(parent.name.toLowerCase());
      out.push(raw ? node.content : encodeEntities(node.content));
      break;
    }
    case "cdata":
      out.push(node.content);
      break;
    case "comment":
      out.push(`<!--${node.content}-->`);
      break;
    case "pi":
      out.push(`<?${node.name}${node.content !== null ? ` ${node.content}` : ""}>`);
      break;
    case "element": {
      const info = lookup(node.name);
      out.push(`<${node.name}`);
      for (const attr of node.attributes) out.push(serializeAttribute(node, attr));
      if (info?.empty) {
        out.push(">");
      } else if (node.children.length === 0) {
        if (info?.saveEndTag && node.name !== "html" && node.name !== "body") out.push(">");
        else out.push(`></${node.name}>`);
      } else {
        out.push(">");
        const block = info !== undefined && !info.inline && node.children.length > 1 && node.name[0] !== "p";
        if (block && node.children[0]!.type !== "text") out.push("\n");
        node.children.forEach((child, i) => serializeNode(child, node, node.children[i + 1], out));
        if (block && node.children.at(-1)!.type !== "text") out.push("\n");
        out.push(`</${node.name}>`);
      }
      if (newlineAfter(node, parent, next)) out.push("\n");
      break;
    }
  }
}

// Node#to_html of one node: htmlNodeDumpFormatOutput looks at the node's real next sibling.
export function serializeNodeHtml(node: HtmlNode): string {
  const out: string[] = [];
  const parent = node.parent;
  const siblings = parent?.children ?? [];
  serializeNode(node, parent, siblings[siblings.indexOf(node) + 1], out);
  return out.join("");
}

// Node#inner_html, and DocumentFragment#to_html: each child dumped on its own.
export function serializeChildren(parent: ParentNode): string {
  return parent.children.map(serializeNodeHtml).join("");
}

// htmlDtdDumpOutput
function serializeDtd(dtd: Dtd): string {
  let out = `<!DOCTYPE ${dtd.name ?? ""}`;
  if (dtd.externalId !== null) {
    out += ` PUBLIC ${quote(dtd.externalId)}`;
    if (dtd.systemId !== null) out += ` ${quote(dtd.systemId)}`;
  } else if (dtd.systemId !== null && dtd.systemId !== "about:legacy-compat") {
    out += ` SYSTEM ${quote(dtd.systemId)}`;
  }
  return `${out}>\n`;
}

// Document#to_html
export function serializeDocument(doc: DocumentNode): string {
  assertMetaCharset(doc);
  const out: string[] = [];
  if (doc.dtd !== null) out.push(serializeDtd(doc.dtd));
  doc.children.forEach((child, i) => serializeNode(child, doc, doc.children[i + 1], out));
  out.push("\n");
  return out.join("");
}

// Every dump runs htmlSetMetaEncoding, which rewrites or inserts the Content-Type meta unless it
// already declares UTF-8. Only that no-op case is reproduced.
function assertMetaCharset(doc: DocumentNode): void {
  const head = findElement(doc, "head");
  const ok =
    head?.children.some(
      (c) =>
        c.type === "element" &&
        c.name === "meta" &&
        getAttribute(c, "http-equiv")?.toLowerCase() === "content-type" &&
        /charset=utf-8$/iu.test(getAttribute(c, "content") ?? ""),
    ) ?? false;
  if (!ok) throw new UnsupportedHtmlError('<head> needs <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">');
}
