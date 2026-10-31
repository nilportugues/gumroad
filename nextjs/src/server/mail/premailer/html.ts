// The part of libxml2 2.13's HTML parser and serializer (as Nokogiri 1.19 drives them) that
// premailer's output depends on. The parser accepts the well-formed markup our mail templates
// produce and throws where libxml2 would restructure the document (auto-closing, implied elements,
// unknown entities), so a template that strays outside that subset fails loudly instead of
// rendering differently from Rails. The serializer is htmlNodeDumpFormatOutput with format on.

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
export type CommentNode = { type: "comment"; content: string; parent: ParentNode | null };
export type DocumentNode = { type: "document"; doctype: string | null; children: HtmlNode[]; parent: null };
export type HtmlNode = ElementNode | TextNode | CommentNode;
export type ParentNode = ElementNode | DocumentNode;

// htmlTagLookup for the fields the serializer reads, recorded from libxml2 2.13 (html.golden.json
// pins it). Tags missing here are unknown to libxml2: no info, so no formatting newlines.
const EMPTY_TAGS = new Set(["area", "base", "basefont", "br", "col", "frame", "hr", "img", "input", "isindex", "link", "meta", "param"]);
const INLINE_TAGS = new Set([
  "a", "abbr", "acronym", "applet", "b", "basefont", "bdo", "big", "br", "button", "cite", "code", "del", "dfn", "em",
  "embed", "font", "i", "iframe", "img", "input", "ins", "kbd", "label", "map", "object", "q", "s", "samp", "script",
  "select", "small", "span", "strike", "strong", "sub", "sup", "textarea", "tt", "u", "var",
]);
const BLOCK_TAGS = new Set([
  "address", "area", "base", "blockquote", "body", "caption", "center", "col", "colgroup", "dd", "dir", "div", "dl", "dt",
  "fieldset", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "html", "isindex", "legend",
  "li", "link", "menu", "meta", "noframes", "noscript", "ol", "optgroup", "option", "p", "param", "pre", "style", "table",
  "tbody", "td", "textarea", "tfoot", "th", "thead", "title", "tr", "ul",
]);
// saveEndTag: printed without an end tag when it has no children.
const SAVE_END_TAG = new Set(["li"]);
const BOOLEAN_ATTRIBUTES = new Set(["checked", "compact", "declare", "defer", "disabled", "ismap", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly", "selected"]);
const RAW_TEXT = new Set(["script", "style"]);
const HEAD_CONTENT = new Set(["title", "meta", "link", "style", "script", "base"]);

// htmlAutoClose: opening the value's tags while the key is the current element closes the key.
// Recorded from libxml2 (html.golden.json pins it); the parser refuses these instead.
const AUTO_CLOSED_BY: Record<string, string[]> = {
  a: ["a", "fieldset", "table", "td", "th"],
  address: ["dd", "dl", "dt", "form", "li", "ul"],
  b: ["center", "p", "td", "th"],
  big: ["p"],
  caption: ["colgroup", "tbody", "tfoot", "thead", "tr", "col"],
  colgroup: ["colgroup", "tbody", "tfoot", "thead", "tr"],
  dd: ["dt"],
  dir: ["dd", "dl", "dt", "form", "ul"],
  dl: ["form", "li"],
  dt: ["dd", "dl"],
  font: ["center", "td", "th"],
  form: ["form"],
  h1: ["fieldset", "form", "li", "p", "table"],
  h2: ["fieldset", "form", "li", "p", "table"],
  h3: ["fieldset", "form", "li", "p", "table"],
  h4: ["fieldset", "form", "li", "p", "table"],
  h5: ["fieldset", "form", "li", "p", "table"],
  h6: ["fieldset", "form", "li", "p", "table"],
  i: ["center", "p", "td", "th"],
  legend: ["fieldset"],
  li: ["li"],
  menu: ["dd", "dl", "dt", "form", "ul"],
  ol: ["form"],
  option: ["optgroup", "option"],
  p: [
    "address", "blockquote", "caption", "center", "colgroup", "dd", "dir", "div", "dl", "dt", "fieldset", "form", "h1", "h2",
    "h3", "h4", "h5", "h6", "li", "menu", "ol", "p", "pre", "table", "tbody", "td", "tfoot", "th", "title", "tr", "ul", "col", "hr",
  ],
  pre: ["dd", "dl", "dt", "fieldset", "form", "li", "table", "ul"],
  s: ["p"],
  small: ["p"],
  span: ["td", "th"],
  strike: ["p"],
  tbody: ["tbody", "tfoot"],
  td: ["tbody", "td", "tfoot", "th", "tr"],
  tfoot: ["tbody"],
  th: ["tbody", "td", "tfoot", "th", "tr"],
  thead: ["tbody", "tfoot"],
  tr: ["tbody", "tfoot", "tr"],
  tt: ["p"],
  u: ["p", "td", "th"],
  ul: ["address", "form", "menu", "pre"],
};

export function isEmptyTag(name: string): boolean {
  return EMPTY_TAGS.has(name);
}

// ---------------------------------------------------------------------------------------------
// Parsing

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/gu, (whole, ref: string) => {
    if (!whole.endsWith(";")) throw new UnsupportedHtmlError(`entity without semicolon: ${whole}`);
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (code < 0x20 && code !== 9 && code !== 10) throw new UnsupportedHtmlError(`character reference ${whole}`);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new UnsupportedHtmlError(`character reference ${whole}`);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[ref];
    if (value === undefined) throw new UnsupportedHtmlError(`entity ${whole}`);
    return value;
  });
}

export function createElement(name: string, attributes: Attribute[] = []): ElementNode {
  return { type: "element", name, attributes, children: [], parent: null };
}

export function appendChild(parent: ParentNode, child: HtmlNode): void {
  child.parent = parent;
  parent.children.push(child);
}

function appendText(parent: ParentNode, content: string): void {
  // libxml2 merges adjacent character data into one text node.
  const last = parent.children.at(-1);
  if (last?.type === "text") last.content += content;
  else appendChild(parent, { type: "text", content, parent: null });
}

const ATTRIBUTE_RX = /[ \t\n\f]*([^\s"'>/=]+)(?:[ \t\n\f]*=[ \t\n\f]*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/uy;

export function parseHtml(html: string): DocumentNode {
  if (html.includes("\r")) throw new UnsupportedHtmlError("carriage return in markup");
  const doc: DocumentNode = { type: "document", doctype: null, children: [], parent: null };
  const stack: ParentNode[] = [doc];
  const current = () => stack.at(-1)!;
  let pos = 0;

  const text = (content: string) => {
    if (content === "") return;
    const node = current();
    // No parent element: libxml2 drops document-level character data.
    if (node.type === "document") {
      if (/^[ \t\n]*$/u.test(content)) return;
      throw new UnsupportedHtmlError("text outside <html>");
    }
    if ((node.name === "html" || node.name === "head") && !/^[ \t\n]*$/u.test(content)) {
      throw new UnsupportedHtmlError(`text directly inside <${node.name}>`);
    }
    appendText(node, RAW_TEXT.has(node.name) ? content : decodeEntities(content));
  };

  while (pos < html.length) {
    const node = current();
    if (node.type === "element" && RAW_TEXT.has(node.name)) {
      const close = html.toLowerCase().indexOf(`</${node.name}`, pos);
      if (close === -1) throw new UnsupportedHtmlError(`unterminated <${node.name}>`);
      text(html.slice(pos, close));
      pos = close;
    }
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      text(html.slice(pos));
      break;
    }
    text(html.slice(pos, lt));
    pos = lt;

    if (html.startsWith("<!--", pos)) {
      const end = html.indexOf("-->", pos + 4);
      if (end === -1) throw new UnsupportedHtmlError("unterminated comment");
      appendChild(current(), { type: "comment", content: html.slice(pos + 4, end), parent: null });
      pos = end + 3;
      continue;
    }
    if (/^<!doctype/iu.test(html.slice(pos, pos + 9))) {
      const end = html.indexOf(">", pos);
      const body = html.slice(pos + 9, end).trim();
      if (body.toLowerCase() !== "html" || doc.doctype !== null || stack.length > 1) throw new UnsupportedHtmlError(`doctype ${body}`);
      doc.doctype = "html";
      pos = end + 1;
      continue;
    }
    if (html[pos + 1] === "/") {
      const match = /^<\/([A-Za-z][A-Za-z0-9]*)[ \t\n]*>/u.exec(html.slice(pos));
      if (!match) throw new UnsupportedHtmlError(`malformed end tag at ${pos}`);
      const name = match[1]!.toLowerCase();
      const top = current();
      if (top.type !== "element" || top.name !== name) throw new UnsupportedHtmlError(`</${name}> does not close the current element`);
      stack.pop();
      pos += match[0].length;
      continue;
    }
    const tag = /^<([A-Za-z][A-Za-z0-9]*)/u.exec(html.slice(pos));
    if (!tag) throw new UnsupportedHtmlError(`stray "<" at ${pos}`);
    const name = tag[1]!.toLowerCase();
    pos += tag[0].length;
    const attributes: Attribute[] = [];
    for (;;) {
      ATTRIBUTE_RX.lastIndex = pos;
      const attr = ATTRIBUTE_RX.exec(html);
      if (!attr) break;
      const attrName = attr[1]!.toLowerCase();
      if (attributes.some((a) => a.name === attrName)) throw new UnsupportedHtmlError(`duplicate attribute ${attrName}`);
      const raw = attr[2] ?? attr[3] ?? attr[4];
      attributes.push({ name: attrName, value: raw === undefined ? null : decodeEntities(raw) });
      pos = ATTRIBUTE_RX.lastIndex;
    }
    const close = /^[ \t\n\f]*(\/?)>/u.exec(html.slice(pos));
    if (!close) throw new UnsupportedHtmlError(`malformed start tag <${name}>`);
    pos += close[0].length;
    if (close[1] === "/" && !EMPTY_TAGS.has(name)) throw new UnsupportedHtmlError(`self-closing <${name}/>`);

    const parent = current();
    checkPlacement(parent, name);
    const element = createElement(name, attributes);
    appendChild(parent, element);
    if (!EMPTY_TAGS.has(name)) stack.push(element);
  }
  if (stack.length > 1) throw new UnsupportedHtmlError(`unclosed <${(current() as ElementNode).name}>`);
  const root = doc.children.filter((c) => c.type === "element");
  if (root.length !== 1 || (root[0] as ElementNode).name !== "html") throw new UnsupportedHtmlError("document needs exactly one <html> root");
  return doc;
}

function checkPlacement(parent: ParentNode, name: string): void {
  if (parent.type === "document") {
    if (name !== "html") throw new UnsupportedHtmlError(`<${name}> outside <html>`);
    return;
  }
  if (parent.name === "html" && name !== "head" && name !== "body") throw new UnsupportedHtmlError(`<${name}> directly inside <html>`);
  if (parent.name === "html") {
    const elements = parent.children.filter((c) => c.type === "element") as ElementNode[];
    if (name === "head" && elements.length > 0) throw new UnsupportedHtmlError("<head> after other content");
    if (name === "body" && (elements.length !== 1 || elements[0]!.name !== "head")) throw new UnsupportedHtmlError("<body> without a preceding <head>");
  }
  if (parent.name === "head" && !HEAD_CONTENT.has(name)) throw new UnsupportedHtmlError(`<${name}> inside <head>`);
  if (name === "html" || name === "head" || name === "body") {
    if (parent.name !== "html") throw new UnsupportedHtmlError(`nested <${name}>`);
  }
  if (AUTO_CLOSED_BY[parent.name]?.includes(name)) throw new UnsupportedHtmlError(`<${name}> inside <${parent.name}> is auto-closed by libxml2`);
}

// ---------------------------------------------------------------------------------------------
// Tree helpers (Nokogiri's API, as premailer uses it)

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

// ---------------------------------------------------------------------------------------------
// Serialization

const lookup = (name: string) => ({
  known: EMPTY_TAGS.has(name) || INLINE_TAGS.has(name) || BLOCK_TAGS.has(name),
  empty: EMPTY_TAGS.has(name),
  inline: INLINE_TAGS.has(name),
  saveEndTag: SAVE_END_TAG.has(name),
});

// xmlEncodeEntitiesReentrant for an HTML document with an encoding: non-ASCII passes through.
function escapeText(text: string): string {
  return text.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// xmlURIEscapeStr(value, "\"#$%&+,/:;<=>?@[\\]^`{|}"): keeps unreserved and the listed characters.
function escapeUri(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value.replace(/^[ \t\n\r]+/u, ""), "utf8")) {
    const c = String.fromCharCode(byte);
    if (byte < 0x80 && /[A-Za-z0-9\-_.!~*'()"#$%&+,/:;<=>?@[\\\]^`{|}]/u.test(c)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// xmlBufWriteQuotedString after the attribute text escaping.
function quoteAttribute(value: string): string {
  const escaped = value.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  if (escaped.includes('"')) {
    if (escaped.includes("'")) return `"${escaped.replaceAll('"', "&quot;")}"`;
    return `'${escaped}'`;
  }
  return `"${escaped}"`;
}

function serializeAttribute(element: ElementNode, attr: Attribute): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(attr.value ?? "")) throw new UnsupportedHtmlError(`control character in ${attr.name}`);
  if (attr.value === null || BOOLEAN_ATTRIBUTES.has(attr.name)) return ` ${attr.name}`;
  const isUri = attr.name === "href" || attr.name === "action" || attr.name === "src" || (attr.name === "name" && element.name === "a");
  return ` ${attr.name}=${quoteAttribute(isUri ? escapeUri(attr.value) : attr.value)}`;
}

const nameStartsWithP = (node: ParentNode | null) => node?.type === "element" && node.name.startsWith("p");

function serializeNode(node: HtmlNode, parent: ParentNode | null, out: string[]): void {
  if (node.type === "text") {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(node.content)) throw new UnsupportedHtmlError("control character in text");
    const raw = parent?.type === "element" && RAW_TEXT.has(parent.name);
    out.push(raw ? node.content : escapeText(node.content));
    return;
  }
  if (node.type === "comment") {
    out.push(`<!--${node.content}-->`);
    return;
  }
  const info = lookup(node.name);
  out.push(`<${node.name}`);
  for (const attr of node.attributes) out.push(serializeAttribute(node, attr));
  if (info.empty) {
    out.push(">");
  } else if (node.children.length === 0) {
    if (info.saveEndTag && node.name !== "html" && node.name !== "body") out.push(">");
    else out.push(`></${node.name}>`);
  } else {
    out.push(">");
    const first = node.children[0]!;
    const last = node.children.at(-1)!;
    if (info.known && !info.inline && first.type !== "text" && node.children.length > 1 && !node.name.startsWith("p")) out.push("\n");
    for (const child of node.children) {
      serializeNode(child, node, out);
      const next = node.children[node.children.indexOf(child) + 1];
      if (child.type === "element" && next) {
        const childInfo = lookup(child.name);
        if (childInfo.known && !childInfo.inline && next.type !== "text" && !nameStartsWithP(node)) out.push("\n");
      }
    }
    if (info.known && !info.inline && last.type !== "text" && node.children.length > 1 && !node.name.startsWith("p")) out.push("\n");
    out.push(`</${node.name}>`);
  }
}

// Node#inner_html: each child dumped on its own. htmlNodeDumpFormatOutput still looks at the dumped
// node's next sibling, so this equals the children's part of a whole-tree dump.
export function serializeChildren(parent: ParentNode): string {
  const out: string[] = [];
  for (const child of parent.children) {
    serializeNode(child, parent, out);
    const next = parent.children[parent.children.indexOf(child) + 1];
    if (child.type === "element" && next) {
      const info = lookup(child.name);
      if (info.known && !info.inline && next.type !== "text" && !nameStartsWithP(parent)) out.push("\n");
    }
  }
  return out.join("");
}

// Document#to_html
export function serializeDocument(doc: DocumentNode): string {
  assertMetaCharset(doc);
  const out: string[] = [];
  if (doc.doctype !== null) out.push(`<!DOCTYPE ${doc.doctype}>\n`);
  for (const child of doc.children) serializeNode(child, null, out);
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
