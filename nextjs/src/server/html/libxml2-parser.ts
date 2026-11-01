// Port of libxml2 2.13.9's HTML parser (HTMLparser.c: htmlParseDocument and what it calls) with
// the SAX2 tree builder (SAX2.c), as Nokogiri 1.19 drives it: htmlReadMemory with an explicit
// UTF-8 encoding and RECOVER | NOERROR | NOWARNING | NONET. It works on the UTF-8 bytes with a NUL
// sentinel, like the C code, because several branches test the raw byte (a NUL inside markup ends
// the document, one inside text becomes a space). Names in comments are the C functions.
import {
  BASE_CHAR_RANGES,
  COMBINING_RANGES,
  DIGIT_RANGES,
  EXTENDER_RANGES,
  HTML40_ELEMENTS,
  HTML40_ENTITIES,
  HTML_START_CLOSE,
  type ElementDesc,
} from "./libxml2-tables.ts";
import {
  appendChild,
  type Attribute,
  type DocumentNode,
  type ElementNode,
  type ParentNode,
  UnsupportedHtmlError,
} from "./libxml2-tree.ts";

const BIG_BUFFER_SIZE = 1000; // HTML_PARSER_BIG_BUFFER_SIZE
const BUFFER_SIZE = 100; // HTML_PARSER_BUFFER_SIZE
const MAX_NAME_LENGTH = 50000; // XML_MAX_NAME_LENGTH
const MAX_DEPTH = 256; // nodePush without XML_PARSE_HUGE

const ELEMENTS = new Map<string, ElementDesc>(HTML40_ELEMENTS.map((e) => [e.name, e]));
const START_CLOSE = new Set(HTML_START_CLOSE.map(([oldTag, newTag]) => `${oldTag} ${newTag}`));
const ENTITIES = new Map<string, number>();
for (const [name, value] of HTML40_ENTITIES) if (!ENTITIES.has(name)) ENTITIES.set(name, value);

const END_PRIORITY: Record<string, number> = { div: 150, td: 160, th: 160, tr: 170, thead: 180, tbody: 180, tfoot: 180, table: 190, head: 200, body: 200, html: 220 };
const NO_CONTENT_ELEMENTS = ["html", "head"];
const ALLOW_PCDATA = new Set([
  "a", "abbr", "acronym", "address", "applet", "b", "bdo", "big", "blockquote", "body", "button", "caption", "center", "cite", "code",
  "dd", "del", "dfn", "div", "dt", "em", "font", "form", "h1", "h2", "h3", "h4", "h5", "h6", "i", "iframe", "ins", "kbd", "label", "legend",
  "li", "noframes", "noscript", "object", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "td", "th", "tt", "u", "var",
]);
const BOOLEAN_ATTRIBUTES = new Set(["checked", "compact", "declare", "defer", "disabled", "ismap", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly", "selected"]);

// htmlTagLookup compares case-insensitively.
export const tagLookup = (name: string | null): ElementDesc | undefined => (name === null ? undefined : ELEMENTS.get(name.toLowerCase()));

const isBlankCh = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isAsciiLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isChar = (c: number) => c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
const isCharCh = (c: number) => c === 0x9 || c === 0xa || c === 0xd || c >= 0x20;
const isPubidCh = (c: number) =>
  c === 0x20 || c === 0x0d || c === 0x0a || isAsciiLetter(c) || isAsciiDigit(c) || "-'()+,./:=?;!*#@$_%".includes(String.fromCharCode(c));
const inRanges = (c: number, ranges: readonly (readonly [number, number])[]) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [low, high] = ranges[mid]!;
    if (c < low) hi = mid - 1;
    else if (c > high) lo = mid + 1;
    else return true;
  }
  return false;
};
// IS_LETTER, IS_DIGIT, IS_COMBINING and IS_EXTENDER (chvalid.h)
const isLetter = (c: number) =>
  c < 0x100
    ? isAsciiLetter(c) || (c >= 0xc0 && c <= 0xd6) || (c >= 0xd8 && c <= 0xf6) || c >= 0xf8
    : inRanges(c, BASE_CHAR_RANGES) || (c >= 0x4e00 && c <= 0x9fa5) || c === 0x3007 || (c >= 0x3021 && c <= 0x3029);
const isDigit = (c: number) => (c < 0x100 ? isAsciiDigit(c) : inRanges(c, DIGIT_RANGES));
const isCombining = (c: number) => c >= 0x100 && inRanges(c, COMBINING_RANGES);
const isExtender = (c: number) => (c < 0x100 ? c === 0xb7 : inRanges(c, EXTENDER_RANGES));
const toUpper =(c: number) => (c >= 0x61 && c <= 0x7a ? c - 0x20 : c);

function utf8(c: number): number[] {
  if (c < 0x80) return [c];
  if (c < 0x800) return [((c >> 6) & 0x1f) | 0xc0, (c & 0x3f) | 0x80];
  if (c < 0x10000) return [((c >> 12) & 0x0f) | 0xe0, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80];
  return [((c >> 18) & 0x07) | 0xf0, ((c >> 12) & 0x3f) | 0x80, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80];
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const text = (bytes: number[] | Uint8Array) => decoder.decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
// A C string stops at its first NUL.
const cString = (bytes: number[]) => {
  const nul = bytes.indexOf(0);
  return text(nul === -1 ? bytes : bytes.slice(0, nul));
};

class HtmlParser {
  private readonly input: Uint8Array;
  private readonly end: number;
  private cur = 0;

  // ctxt->html: 1 while parsing, 3 once a <head> was pushed, 10 once a <body> was.
  private htmlState = 1;
  private readonly nameTab: string[] = [];
  private depth = 0;

  readonly doc: DocumentNode = { type: "document", dtd: null, children: [], parent: null };
  private readonly nodeTab: ElementNode[] = [];

  constructor(html: string) {
    const bytes = Buffer.from(html, "utf8");
    this.input = new Uint8Array(bytes.length + 8);
    this.input.set(bytes);
    this.end = bytes.length;
  }

  private get name(): string | null {
    return this.nameTab.length > 0 ? this.nameTab[this.nameTab.length - 1]! : null;
  }

  private get node(): ElementNode | null {
    return this.nodeTab.length > 0 ? this.nodeTab[this.nodeTab.length - 1]! : null;
  }

  private at(i: number): number {
    return i < this.end ? this.input[i]! : 0;
  }

  private c(): number {
    return this.at(this.cur);
  }

  private NXT(n: number): number {
    return this.at(this.cur + n);
  }

  private UPP(n: number): number {
    return toUpper(this.NXT(n));
  }

  // xmlNextChar: one UTF-8 character, or "\r\n" as one.
  private NEXT(): void {
    if (this.cur >= this.end) return;
    const c = this.input[this.cur]!;
    if (c < 0x80) {
      this.cur += c === 0x0d && this.at(this.cur + 1) === 0x0a ? 2 : 1;
      return;
    }
    this.cur += c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
  }

  private SKIP(n: number): void {
    this.cur += n;
  }

  // htmlCurrentChar for UTF-8 input; [char, length]. A NUL inside the input reads as a space.
  private curChar(): [number, number] {
    if (this.cur >= this.end) return [0, 0];
    const c = this.input[this.cur]!;
    if (c < 0x80) return c === 0 ? [0x20, 1] : [c, 1];
    if (c < 0xe0) return [((c & 0x1f) << 6) | (this.at(this.cur + 1) & 0x3f), 2];
    if (c < 0xf0) return [((c & 0x0f) << 12) | ((this.at(this.cur + 1) & 0x3f) << 6) | (this.at(this.cur + 2) & 0x3f), 3];
    return [((c & 0x07) << 18) | ((this.at(this.cur + 1) & 0x3f) << 12) | ((this.at(this.cur + 2) & 0x3f) << 6) | (this.at(this.cur + 3) & 0x3f), 4];
  }

  private skipBlanks(): void {
    while (isBlankCh(this.c())) this.cur++;
  }

  // ------------------------------------------------------------------------------------------
  // SAX2 tree building (xmlSAX2StartElement, xmlSAX2EndElement, xmlSAX2Text, ...)

  private startElement(name: string, atts: [string, string | null][] | null): void {
    const element: ElementNode = { type: "element", name, attributes: [], children: [], parent: null };
    appendChild(this.node ?? this.doc, element);
    if (this.nodeTab.length > MAX_DEPTH) throw new UnsupportedHtmlError(`nesting deeper than ${MAX_DEPTH} elements`);
    this.nodeTab.push(element);
    for (const [attName, value] of atts ?? []) {
      // xmlSAX2AttributeInternal: a valueless boolean attribute takes its own name as value.
      const attribute: Attribute = { name: attName, value: value === null && BOOLEAN_ATTRIBUTES.has(attName) ? attName : value };
      element.attributes.push(attribute);
    }
  }

  private endElement(): void {
    this.nodeTab.pop();
  }

  private characters(bytes: number[], cdata = false): void {
    const node = this.node;
    if (node === null) return;
    const content = text(bytes);
    const type = cdata ? "cdata" : "text";
    const last = node.children.at(-1);
    if (last !== undefined && last.type === type) last.content += content;
    else appendChild(node, { type, content, parent: null });
  }

  private comment(content: string): void {
    appendChild(this.node ?? this.doc, { type: "comment", content, parent: null });
  }

  private processingInstruction(target: string, data: string | null): void {
    appendChild(this.node ?? this.doc, { type: "pi", name: target, content: data, parent: null });
  }

  private internalSubset(name: string | null, externalId: string | null, systemId: string | null): void {
    if (this.doc.dtd !== null) return;
    this.doc.dtd = { name, externalId, systemId };
  }

  // ------------------------------------------------------------------------------------------
  // Name stack and implied/auto-closed elements

  private namePush(value: string): void {
    if (this.htmlState < 3 && value === "head") this.htmlState = 3;
    if (this.htmlState < 10 && value === "body") this.htmlState = 10;
    this.nameTab.push(value);
  }

  private namePop(): void {
    this.nameTab.pop();
  }

  // htmlCheckAutoClose
  private static autoCloses(newtag: string, oldtag: string): boolean {
    return START_CLOSE.has(`${oldtag} ${newtag}`);
  }

  // htmlAutoCloseOnClose
  private autoCloseOnClose(newtag: string): void {
    const priority = END_PRIORITY[newtag] ?? 100;
    let i: number;
    for (i = this.nameTab.length - 1; i >= 0; i--) {
      if (newtag === this.nameTab[i]) break;
      if ((END_PRIORITY[this.nameTab[i]!] ?? 100) > priority) return;
    }
    if (i < 0) return;
    while (newtag !== this.name) {
      this.endElement();
      this.namePop();
    }
  }

  // htmlAutoCloseOnEnd
  private autoCloseOnEnd(): void {
    for (let i = this.nameTab.length - 1; i >= 0; i--) {
      this.endElement();
      this.namePop();
    }
  }

  // htmlAutoClose
  private autoClose(newtag: string): void {
    while (this.name !== null && HtmlParser.autoCloses(newtag, this.name)) {
      this.endElement();
      this.namePop();
    }
  }

  // htmlCheckImplied
  private checkImplied(newtag: string): void {
    if (newtag === "html") return;
    if (this.nameTab.length <= 0) {
      this.namePush("html");
      this.startElement("html", null);
    }
    if (newtag === "body" || newtag === "head") return;
    if (this.nameTab.length <= 1 && ["script", "style", "meta", "link", "title", "base"].includes(newtag)) {
      if (this.htmlState >= 3) return;
      this.namePush("head");
      this.startElement("head", null);
    } else if (newtag !== "noframes" && newtag !== "frame" && newtag !== "frameset") {
      if (this.htmlState >= 10) return;
      for (const name of this.nameTab) {
        if (name === "body" || name === "head") return;
      }
      this.namePush("body");
      this.startElement("body", null);
    }
  }

  // htmlCheckParagraph
  private checkParagraph(): void {
    const tag = this.name;
    if (tag === null || NO_CONTENT_ELEMENTS.includes(tag)) {
      this.autoClose("p");
      this.checkImplied("p");
      this.namePush("p");
      this.startElement("p", null);
    }
  }

  // areBlanks
  private areBlanks(bytes: number[]): boolean {
    for (const b of bytes) if (!isBlankCh(b)) return false;
    if (this.c() === 0) return true;
    if (this.c() !== 0x3c) return false;
    const name = this.name;
    if (name === null || name === "html" || name === "head") return true;
    if (name === "body" && this.doc.dtd?.externalId != null) {
      const id = this.doc.dtd.externalId.toLowerCase();
      if (id === "-//w3c//dtd html 4.01//en" || id === "-//w3c//dtd html 4//en") return true;
    }
    const node = this.node;
    if (node === null) return false;
    let last = node.children.length - 1;
    while (last >= 0 && node.children[last]!.type === "comment") last--;
    if (last < 0) {
      if (ALLOW_PCDATA.has(name)) return false;
    } else {
      const child = node.children[last]!;
      if (child.type === "text") return false;
      if ((child.type === "element" || child.type === "pi") && ALLOW_PCDATA.has(child.name)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Lexical pieces

  // htmlParseHTMLName: lowercased, at most HTML_PARSER_BUFFER_SIZE characters.
  private parseHTMLName(): string | null {
    const c = this.c();
    if (!isAsciiLetter(c) && c !== 0x5f && c !== 0x3a && c !== 0x2e) return null;
    const loc: number[] = [];
    while (loc.length < BUFFER_SIZE) {
      const ch = this.c();
      if (!(isAsciiLetter(ch) || isAsciiDigit(ch) || ch === 0x3a || ch === 0x2d || ch === 0x5f || ch === 0x2e)) break;
      loc.push(ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch);
      this.NEXT();
    }
    return text(loc);
  }

  // htmlParseHTMLName_nonInvasive
  private parseHTMLNameNonInvasive(): string | null {
    const first = this.NXT(1);
    if (!isAsciiLetter(first) && first !== 0x5f && first !== 0x3a) return null;
    const loc: number[] = [];
    while (loc.length < BUFFER_SIZE) {
      const ch = this.NXT(1 + loc.length);
      if (!(isAsciiLetter(ch) || isAsciiDigit(ch) || ch === 0x3a || ch === 0x2d || ch === 0x5f)) break;
      loc.push(ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch);
    }
    return text(loc);
  }

  // htmlParseName
  private parseName(): string | null {
    const start = this.cur;
    let i = start;
    const c0 = this.at(i);
    if (isAsciiLetter(c0) || c0 === 0x5f || c0 === 0x3a) {
      i++;
      while (true) {
        const c = this.at(i);
        if (isAsciiLetter(c) || isAsciiDigit(c) || c === 0x5f || c === 0x2d || c === 0x3a || c === 0x2e) i++;
        else break;
      }
      if (i === this.end) return null;
      const c = this.at(i);
      if (c > 0 && c < 0x80) {
        this.cur = i;
        return text(this.input.subarray(start, i));
      }
    }
    return this.parseNameComplex();
  }

  // htmlParseNameComplex
  private parseNameComplex(): string | null {
    const start = this.cur;
    let [c, l] = this.curChar();
    if (c === 0x20 || c === 0x3e || c === 0x2f || (!isLetter(c) && c !== 0x5f && c !== 0x3a)) return null;
    let len = 0;
    while (
      c !== 0x20 &&
      c !== 0x3e &&
      c !== 0x2f &&
      (isLetter(c) || isDigit(c) || c === 0x2e || c === 0x2d || c === 0x5f || c === 0x3a || isCombining(c) || isExtender(c))
    ) {
      len += l;
      if (len > MAX_NAME_LENGTH) return null;
      this.cur += l;
      [c, l] = this.curChar();
    }
    return text(this.input.subarray(start, this.cur));
  }

  // htmlParseCharRef
  private parseCharRef(): number {
    let val = 0;
    if (this.c() === 0x26 && this.NXT(1) === 0x23 && (this.NXT(2) === 0x78 || this.NXT(2) === 0x58)) {
      this.SKIP(3);
      while (this.c() !== 0x3b) {
        const c = this.c();
        if (c >= 0x30 && c <= 0x39) {
          if (val < 0x110000) val = val * 16 + (c - 0x30);
        } else if (c >= 0x61 && c <= 0x66) {
          if (val < 0x110000) val = val * 16 + (c - 0x61) + 10;
        } else if (c >= 0x41 && c <= 0x46) {
          if (val < 0x110000) val = val * 16 + (c - 0x41) + 10;
        } else break;
        this.NEXT();
      }
      if (this.c() === 0x3b) this.NEXT();
    } else if (this.c() === 0x26 && this.NXT(1) === 0x23) {
      this.SKIP(2);
      while (this.c() !== 0x3b) {
        const c = this.c();
        if (c >= 0x30 && c <= 0x39) {
          if (val < 0x110000) val = val * 10 + (c - 0x30);
        } else break;
        this.NEXT();
      }
      if (this.c() === 0x3b) this.NEXT();
    }
    return isChar(val) ? val : 0;
  }

  // htmlParseEntityRef: [entity value or null, name or null]
  private parseEntityRef(): [number | null, string | null] {
    if (this.c() !== 0x26) return [null, null];
    this.NEXT();
    const name = this.parseName();
    if (name === null) return [null, null];
    if (this.c() === 0x3b) {
      const value = ENTITIES.get(name) ?? null;
      if (value !== null) this.NEXT();
      return [value, name];
    }
    return [null, name];
  }

  // htmlParseHTMLAttribute
  private parseHTMLAttribute(stop: number): number[] {
    const out: number[] = [];
    while (this.c() !== 0 && this.c() !== stop) {
      if (stop === 0 && this.c() === 0x3e) break;
      if (stop === 0 && isBlankCh(this.c())) break;
      if (this.c() === 0x26) {
        if (this.NXT(1) === 0x23) {
          out.push(...utf8(this.parseCharRef()));
        } else {
          const [value, name] = this.parseEntityRef();
          if (name === null) out.push(0x26);
          else if (value === null) out.push(0x26, ...Buffer.from(name, "utf8"));
          else out.push(...utf8(value));
        }
      } else {
        const [c, l] = this.curChar();
        out.push(...utf8(c));
        this.cur += l;
      }
    }
    return out;
  }

  // htmlParseAttValue
  private parseAttValue(): string | null {
    let bytes: number[];
    if (this.c() === 0x22) {
      this.NEXT();
      bytes = this.parseHTMLAttribute(0x22);
      if (this.c() === 0x22) this.NEXT();
    } else if (this.c() === 0x27) {
      this.NEXT();
      bytes = this.parseHTMLAttribute(0x27);
      if (this.c() === 0x27) this.NEXT();
    } else {
      bytes = this.parseHTMLAttribute(0);
    }
    return cString(bytes);
  }

  // htmlParseAttribute
  private parseAttribute(): [string | null, string | null] {
    const name = this.parseHTMLName();
    if (name === null) return [null, null];
    this.skipBlanks();
    let value: string | null = null;
    if (this.c() === 0x3d) {
      this.NEXT();
      this.skipBlanks();
      value = this.parseAttValue();
    }
    return [name, value];
  }

  // htmlParseSystemLiteral / htmlParsePubidLiteral: the length counts NEXT steps, so a "\r\n"
  // inside shortens the copy by one byte, as in C.
  private parseLiteral(valid: (c: number) => boolean): string | null {
    if (this.c() !== 0x22 && this.c() !== 0x27) return null;
    const quote = this.c();
    this.NEXT();
    const start = this.cur;
    let len = 0;
    let err = false;
    while (this.c() !== 0 && this.c() !== quote) {
      if (!valid(this.c())) err = true;
      this.NEXT();
      len++;
    }
    if (this.c() !== quote) return null;
    const ret = err ? null : text(this.input.subarray(start, start + len));
    this.NEXT();
    return ret;
  }

  // htmlParseExternalID: [URI, publicID]
  private parseExternalID(): [string | null, string | null] {
    let uri: string | null = null;
    let publicId: string | null = null;
    const word = (w: string) => [...w].every((ch, i) => this.UPP(i) === ch.charCodeAt(0));
    if (word("SYSTEM")) {
      this.SKIP(6);
      this.skipBlanks();
      uri = this.parseLiteral(isCharCh);
    } else if (word("PUBLIC")) {
      this.SKIP(6);
      this.skipBlanks();
      publicId = this.parseLiteral(isPubidCh);
      this.skipBlanks();
      if (this.c() === 0x22 || this.c() === 0x27) uri = this.parseLiteral(isCharCh);
    }
    return [uri, publicId];
  }

  // htmlParseDocTypeDecl
  private parseDocTypeDecl(): void {
    this.SKIP(9);
    this.skipBlanks();
    const name = this.parseName();
    this.skipBlanks();
    const [uri, externalId] = this.parseExternalID();
    this.skipBlanks();
    if (this.c() !== 0x3e) {
      while (this.c() !== 0 && this.c() !== 0x3e) this.NEXT();
    }
    if (this.c() === 0x3e) this.NEXT();
    this.internalSubset(name, externalId, uri);
  }

  // htmlParseComment
  private parseComment(): void {
    if (this.c() !== 0x3c || this.NXT(1) !== 0x21 || this.NXT(2) !== 0x2d || this.NXT(3) !== 0x2d) return;
    this.SKIP(4);
    const buf: number[] = [];
    let [q, ql] = this.curChar();
    let cur: number;
    finished: {
      if (q === 0) return;
      if (q === 0x3e) {
        cur = 0x3e;
        break finished;
      }
      this.cur += ql;
      let [r, rl] = this.curChar();
      if (r === 0) return;
      if (q === 0x2d && r === 0x3e) {
        cur = 0x3e;
        break finished;
      }
      this.cur += rl;
      let l: number;
      [cur, l] = this.curChar();
      while (cur !== 0 && (cur !== 0x3e || r !== 0x2d || q !== 0x2d)) {
        this.cur += l;
        const [next, nl] = this.curChar();
        if (q === 0x2d && r === 0x2d && cur === 0x21 && next === 0x3e) {
          cur = 0x3e;
          break;
        }
        if (isChar(q)) buf.push(...utf8(q));
        q = r;
        ql = rl;
        r = cur;
        rl = l;
        cur = next;
        l = nl;
      }
    }
    if (cur === 0x3e) {
      this.NEXT();
      this.comment(text(buf));
    }
  }

  // htmlSkipBogusComment
  private skipBogusComment(): void {
    for (;;) {
      const c = this.c();
      if (c === 0) break;
      this.NEXT();
      if (c === 0x3e) break;
    }
  }

  // htmlParsePI
  private parsePI(): void {
    if (this.c() !== 0x3c || this.NXT(1) !== 0x3f) return;
    this.SKIP(2);
    const target = this.parseName();
    if (target === null) return;
    if (this.c() === 0x3e) {
      this.SKIP(1);
      this.processingInstruction(target, null);
      return;
    }
    this.skipBlanks();
    const buf: number[] = [];
    let [cur, l] = this.curChar();
    while (cur !== 0 && cur !== 0x3e) {
      if (isChar(cur)) buf.push(...utf8(cur));
      this.cur += l;
      [cur, l] = this.curChar();
    }
    if (cur === 0x3e) {
      this.SKIP(1);
      this.processingInstruction(target, text(buf));
    }
  }

  // htmlParseScript: element content up to the matching end tag, as CDATA.
  private parseScript(): void {
    const buf: number[] = [];
    let [cur, l] = this.curChar();
    while (cur !== 0) {
      if (cur === 0x3c && this.NXT(1) === 0x2f) {
        const name = this.name ?? "";
        let matches = true;
        for (let i = 0; i < name.length; i++) {
          if (toUpper(this.at(this.cur + 2 + i)) !== toUpper(name.charCodeAt(i))) {
            matches = false;
            break;
          }
        }
        if (matches) break;
      }
      if (isChar(cur)) buf.push(...utf8(cur));
      this.cur += l;
      if (buf.length >= BIG_BUFFER_SIZE) {
        this.characters(buf.splice(0), true);
      }
      [cur, l] = this.curChar();
    }
    if (buf.length !== 0) this.characters(buf, true);
  }

  private flushCharData(buf: number[]): void {
    if (this.areBlanks(buf)) {
      this.characters(buf);
    } else {
      this.checkParagraph();
      this.characters(buf);
    }
  }

  // htmlParseCharDataInternal
  private parseCharData(): void {
    let buf: number[] = [];
    let [cur, l] = this.curChar();
    while (cur !== 0x3c && cur !== 0x26 && cur !== 0) {
      if (isChar(cur)) buf.push(...utf8(cur));
      this.cur += l;
      if (buf.length >= BIG_BUFFER_SIZE) {
        this.flushCharData(buf);
        buf = [];
      }
      [cur, l] = this.curChar();
    }
    if (buf.length !== 0) this.flushCharData(buf);
  }

  // htmlParseReference
  private parseReference(): void {
    if (this.c() !== 0x26) return;
    if (this.NXT(1) === 0x23) {
      const c = this.parseCharRef();
      if (c === 0) return;
      this.checkParagraph();
      this.characters(utf8(c));
      return;
    }
    const [value, name] = this.parseEntityRef();
    if (name === null) {
      this.checkParagraph();
      this.characters([0x26]);
      return;
    }
    if (value === null || !(value > 0)) {
      this.checkParagraph();
      this.characters([0x26]);
      this.characters([...Buffer.from(name, "utf8")]);
      return;
    }
    this.checkParagraph();
    this.characters(utf8(value));
  }

  // htmlParseStartTag: -1 on error, 1 when the tag was discarded, 0 otherwise.
  private parseStartTag(): number {
    if (this.c() !== 0x3c) return -1;
    this.NEXT();
    const name = this.parseHTMLName();
    if (name === null) {
      while (this.c() !== 0 && this.c() !== 0x3e) this.NEXT();
      return -1;
    }
    this.autoClose(name);
    this.checkImplied(name);

    let discard = 0;
    if (this.nameTab.length > 0 && name === "html") {
      discard = 1;
      this.depth++;
    }
    if (this.nameTab.length !== 1 && name === "head") {
      discard = 1;
      this.depth++;
    }
    if (name === "body") {
      for (const open of this.nameTab) {
        if (open === "body") {
          discard = 1;
          this.depth++;
        }
      }
    }

    const atts: [string, string | null][] = [];
    this.skipBlanks();
    while (this.c() !== 0 && this.c() !== 0x3e && (this.c() !== 0x2f || this.NXT(1) !== 0x3e)) {
      const [attName, attValue] = this.parseAttribute();
      if (attName !== null) {
        if (!atts.some(([n]) => n === attName)) atts.push([attName, attValue]);
      } else {
        while (this.c() !== 0 && !isBlankCh(this.c()) && this.c() !== 0x3e && (this.c() !== 0x2f || this.NXT(1) !== 0x3e)) this.NEXT();
      }
      this.skipBlanks();
    }

    if (!discard) {
      this.namePush(name);
      this.startElement(name, atts.length !== 0 ? atts : null);
    }
    return discard;
  }

  // htmlParseEndTag: true when the current level was closed.
  private parseEndTag(): boolean {
    if (this.c() !== 0x3c || this.NXT(1) !== 0x2f) return false;
    this.SKIP(2);
    const name = this.parseHTMLName();
    if (name === null) return false;
    this.skipBlanks();
    if (this.c() !== 0x3e) {
      while (this.c() !== 0 && this.c() !== 0x3e) this.NEXT();
    }
    if (this.c() === 0x3e) this.NEXT();

    if (this.depth > 0 && (name === "html" || name === "body" || name === "head")) {
      this.depth--;
      return false;
    }
    if (!this.nameTab.includes(name)) return false;
    this.autoCloseOnClose(name);
    if (this.name !== null && this.name === name) {
      this.endElement();
      this.namePop();
      return true;
    }
    return false;
  }

  // htmlParserFinishElementParsing
  private finishElementParsing(): void {
    if (this.c() === 0) this.autoCloseOnEnd();
  }

  // htmlParseElementInternal
  private parseElementInternal(): void {
    const failed = this.parseStartTag();
    const name = this.name;
    if (failed === -1 || name === null) {
      if (this.c() === 0x3e) this.NEXT();
      return;
    }
    const info = tagLookup(name);
    if (this.c() === 0x2f && this.NXT(1) === 0x3e) {
      this.SKIP(2);
      this.endElement();
      this.namePop();
      return;
    }
    if (this.c() === 0x3e) {
      this.NEXT();
    } else {
      // "Couldn't find end of Start Tag": nodePop and htmlnamePop, without endElement.
      if (name === this.name) {
        this.nodeTab.pop();
        this.namePop();
      }
      this.finishElementParsing();
      return;
    }
    if (info !== undefined && info.empty) {
      this.endElement();
      this.namePop();
    }
  }

  // htmlParseContentInternal
  private parseContentInternal(): void {
    let depth = this.nameTab.length;
    let currentNode: string | null = depth <= 0 ? null : this.name;
    for (;;) {
      if (this.c() === 0x3c && this.NXT(1) === 0x2f) {
        if (this.parseEndTag() && (currentNode !== null || this.nameTab.length === 0)) {
          depth = this.nameTab.length;
          currentNode = depth <= 0 ? null : this.name;
        }
        continue;
      } else if (this.c() === 0x3c && (isAsciiLetter(this.NXT(1)) || this.NXT(1) === 0x5f || this.NXT(1) === 0x3a)) {
        const name = this.parseHTMLNameNonInvasive()!;
        if (this.name !== null && HtmlParser.autoCloses(name, this.name)) {
          this.autoClose(name);
          continue;
        }
      }

      if (this.nameTab.length > 0 && depth >= this.nameTab.length && currentNode !== this.name) {
        this.finishElementParsing();
        currentNode = this.name;
        depth = this.nameTab.length;
        continue;
      }

      if (this.c() !== 0 && (currentNode === "script" || currentNode === "style")) {
        this.parseScript();
      } else if (this.c() === 0x3c && this.NXT(1) === 0x21) {
        if ([..."DOCTYPE"].every((ch, i) => this.UPP(2 + i) === ch.charCodeAt(0))) this.parseDocTypeDecl();
        else if (this.NXT(2) === 0x2d && this.NXT(3) === 0x2d) this.parseComment();
        else this.skipBogusComment();
      } else if (this.c() === 0x3c && this.NXT(1) === 0x3f) {
        this.parsePI();
      } else if (this.c() === 0x3c && isAsciiLetter(this.NXT(1))) {
        this.parseElementInternal();
        currentNode = this.name;
        depth = this.nameTab.length;
      } else if (this.c() === 0x3c) {
        this.characters([0x3c]);
        this.NEXT();
      } else if (this.c() === 0x26) {
        this.parseReference();
      } else if (this.c() === 0) {
        this.autoCloseOnEnd();
        break;
      } else {
        this.parseCharData();
      }
    }
  }

  private atCommentOrPI(): boolean {
    return (this.c() === 0x3c && this.NXT(1) === 0x21 && this.NXT(2) === 0x2d && this.NXT(3) === 0x2d) || (this.c() === 0x3c && this.NXT(1) === 0x3f);
  }

  // htmlParseDocument
  parseDocument(): DocumentNode {
    // xmlDetectEncoding with the encoding given: a UTF-8 byte order mark is skipped.
    if (this.end >= 4 && this.at(0) === 0xef && this.at(1) === 0xbb && this.at(2) === 0xbf) this.cur = 3;
    this.skipBlanks();
    while (this.atCommentOrPI()) {
      this.parseComment();
      this.parsePI();
      this.skipBlanks();
    }
    if (this.c() === 0x3c && this.NXT(1) === 0x21 && [..."DOCTYPE"].every((ch, i) => this.UPP(2 + i) === ch.charCodeAt(0))) {
      this.parseDocTypeDecl();
    }
    this.skipBlanks();
    while (this.atCommentOrPI()) {
      this.parseComment();
      this.parsePI();
      this.skipBlanks();
    }
    this.parseContentInternal();
    if (this.c() === 0) this.autoCloseOnEnd();
    if (this.doc.dtd === null) {
      this.doc.dtd = { name: "html", externalId: "-//W3C//DTD HTML 4.0 Transitional//EN", systemId: "http://www.w3.org/TR/REC-html40/loose.dtd" };
    }
    return this.doc;
  }
}

// Nokogiri::HTML4::Document.parse(html, nil, "UTF-8")
export function parseHtmlDocument(html: string): DocumentNode {
  return new HtmlParser(html).parseDocument();
}

export type { ParentNode };
