// Port of YAML.safe_dump / YAML.safe_load as ActiveRecord::Coders::YAMLColumn calls them
// (psych 5.2.6 on libyaml 0.2.5, permitted_classes: [Symbol]). Dumping ports Psych's YAMLTree
// style choices and libyaml's emitter (scalar analysis, quoting, 80-column folding) so the
// bytes match what Rails writes; loading parses with the `yaml` package and types plain
// scalars with Psych's ScalarScanner.
import { isMap, isScalar, isSeq, parseDocument, Scalar as YamlScalar, type Node as YamlNode } from "yaml";

import { tokenize } from "./psych-scalar-scanner.ts";
import { floatValue, isPlainHash, isRubyFloat, RubyFloat, rubyFloatToS, RubySymbol, type RubyValue } from "./ruby-values.ts";

// A Hash whose keys are not all strings (Ruby allows any key; JS objects do not).
export class RubyHash {
  constructor(readonly entries: [YamlValue, YamlValue][]) {}
}
export type YamlValue = RubyValue | RubyHash | YamlValue[] | { [key: string]: YamlValue };

export class DisallowedClass extends Error {
  constructor(className: string) {
    super(`Tried to load unspecified class: ${className}`);
    this.name = "Psych::DisallowedClass";
  }
}

// ---------------------------------------------------------------------------------------------
// YAMLTree: Ruby object -> representation nodes

type Style = "any" | "plain" | "single" | "double" | "literal";
type ScalarNode = { kind: "scalar"; value: string; tag: string | null; plainImplicit: boolean; quotedImplicit: boolean; style: Style };
type ReprNode = ScalarNode | { kind: "seq"; items: ReprNode[] } | { kind: "map"; pairs: [ReprNode, ReprNode][] };

const scalar = (value: string, tag: string | null, plainImplicit: boolean, quotedImplicit: boolean, style: Style): ScalarNode => ({
  kind: "scalar",
  value,
  tag,
  plainImplicit,
  quotedImplicit,
  style,
});

const NOT_WORD_START = /^[^\p{L}\p{M}\p{Nd}\p{Pc}][^"]*$/mu;

// At dump time the scanner may build a Date or Time; an ArgumentError while parsing leaves a string.
function loadsAsString(o: string): boolean {
  const token = tokenize(o);
  if (token.kind === "date" || token.kind === "time") return !token.valid;
  return token.kind === "string";
}

function visitString(o: string): ScalarNode {
  // Psych: /\n(?!\Z)/ — a newline that is not the string's final one.
  if (/\n(?!\n?$)/u.test(o)) return scalar(o, null, true, true, "literal");
  if (o === "<<") return scalar(o, "tag:yaml.org,2002:str", false, false, "single");
  if (o === "y" || o === "Y" || o === "n" || o === "N") return scalar(o, null, true, true, "double");
  if (NOT_WORD_START.test(o)) return scalar(o, null, true, true, "double");
  if (!loadsAsString(o) || /^0[0-7]*[89]/u.test(o)) return scalar(o, null, true, true, "single");
  return scalar(o, null, true, true, "plain");
}

function represent(value: YamlValue): ReprNode {
  if (value === null || value === undefined) return scalar("", "tag:yaml.org,2002:null", true, false, "any");
  if (typeof value === "boolean") return scalar(String(value), null, true, false, "any");
  if (typeof value === "bigint") return scalar(value.toString(), null, true, false, "any");
  if (typeof value === "number" && Number.isInteger(value)) return scalar(String(value), null, true, false, "any");
  if (isRubyFloat(value)) {
    const f = floatValue(value);
    const text = Number.isNaN(f) ? ".nan" : f === Infinity ? ".inf" : f === -Infinity ? "-.inf" : rubyFloatToS(f);
    return scalar(text, null, true, false, "any");
  }
  if (typeof value === "string") return visitString(value);
  if (value instanceof RubySymbol) {
    return value.name === "" ? scalar("", "!ruby/symbol", false, false, "any") : scalar(`:${value.name}`, null, true, false, "any");
  }
  if (Array.isArray(value)) return { kind: "seq", items: value.map(represent) };
  if (value instanceof RubyHash) return { kind: "map", pairs: value.entries.map(([k, v]) => [represent(k), represent(v)]) };
  if (isPlainHash(value)) return { kind: "map", pairs: Object.entries(value).map(([k, v]) => [represent(k), represent(v as YamlValue)]) };
  throw new TypeError(`Cannot dump ${String(value)} to YAML`);
}

// ---------------------------------------------------------------------------------------------
// libyaml 0.2.5 emitter (block style, unicode on, best_indent 2, best_width 80)

const BEST_INDENT = 2;
const BEST_WIDTH = 80;
const isBreak = (c: number | undefined) => c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029;
const isSpace = (c: number | undefined) => c === 0x20;
const isBlankz = (c: number | undefined) => c === undefined || c === 0 || c === 0x20 || c === 0x09 || isBreak(c);
const isPrintable = (c: number) =>
  c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff);

type Analysis = {
  multiline: boolean;
  flowPlainAllowed: boolean;
  blockPlainAllowed: boolean;
  singleQuotedAllowed: boolean;
  blockAllowed: boolean;
};

function analyzeScalar(value: string): Analysis {
  const chars = [...value].map((ch) => ch.codePointAt(0)!);
  if (chars.length === 0) {
    return { multiline: false, flowPlainAllowed: false, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: false };
  }
  let blockIndicators = false;
  let flowIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let previousSpace = false;
  let previousBreak = false;

  if (value.startsWith("---") || value.startsWith("...")) {
    blockIndicators = true;
    flowIndicators = true;
  }
  let precededByWhitespace = true;
  let followedByWhitespace = isBlankz(chars[1]);

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const ch = String.fromCodePoint(c);
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
        flowIndicators = true;
        blockIndicators = true;
      }
      if (ch === "?" || ch === ":") {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === "-" && followedByWhitespace) {
        flowIndicators = true;
        blockIndicators = true;
      }
    } else {
      if (",?[]{}".includes(ch)) flowIndicators = true;
      if (ch === ":") {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === "#" && precededByWhitespace) {
        flowIndicators = true;
        blockIndicators = true;
      }
    }
    if (!isPrintable(c)) specialCharacters = true;
    if (isBreak(c)) lineBreaks = true;

    if (isSpace(c)) {
      if (i === 0) leadingSpace = true;
      if (i === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isBreak(c)) {
      if (i === 0) leadingBreak = true;
      if (i === chars.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = isBlankz(c);
    followedByWhitespace = isBlankz(chars[i + 2]);
  }

  const a: Analysis = { multiline: lineBreaks, flowPlainAllowed: true, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: true };
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
    a.flowPlainAllowed = false;
    a.blockPlainAllowed = false;
  }
  if (trailingSpace) a.blockAllowed = false;
  if (breakSpace) {
    a.flowPlainAllowed = false;
    a.blockPlainAllowed = false;
    a.singleQuotedAllowed = false;
  }
  if (spaceBreak || specialCharacters) {
    a.flowPlainAllowed = false;
    a.blockPlainAllowed = false;
    a.singleQuotedAllowed = false;
    a.blockAllowed = false;
  }
  if (lineBreaks) {
    a.flowPlainAllowed = false;
    a.blockPlainAllowed = false;
  }
  if (flowIndicators) a.flowPlainAllowed = false;
  if (blockIndicators) a.blockPlainAllowed = false;
  return a;
}

// Default tag directives: "!" and "!!" (tag:yaml.org,2002:).
function shortTag(tag: string): { handle: string; suffix: string } {
  if (tag.startsWith("tag:yaml.org,2002:")) return { handle: "!!", suffix: tag.slice("tag:yaml.org,2002:".length) };
  if (tag.startsWith("!")) return { handle: "!", suffix: tag.slice(1) };
  return { handle: "", suffix: tag };
}

const utf8Length = (s: string) => Buffer.byteLength(s, "utf8");

class Emitter {
  out = "";
  column = 0;
  whitespace = true;
  indention = true;
  openEnded = 0;
  indent = -1;
  indents: number[] = [];
  flowLevel = 0;
  // Context of the node being emitted.
  rootContext = false;
  mappingContext = false;
  simpleKeyContext = false;

  put(s: string) {
    this.out += s;
    this.column += [...s].length;
  }

  putBreak() {
    this.out += "\n";
    this.column = 0;
  }

  // WRITE_BREAK: "\n" becomes the line break; other break characters are copied as-is.
  writeBreak(c: number) {
    if (c === 0x0a) this.putBreak();
    else {
      this.out += String.fromCodePoint(c);
      this.column = 0;
    }
  }

  increaseIndent(flow: boolean, indentless: boolean) {
    this.indents.push(this.indent);
    if (this.indent < 0) this.indent = flow ? BEST_INDENT : 0;
    else if (!indentless) this.indent += BEST_INDENT;
  }

  popIndent() {
    this.indent = this.indents.pop()!;
  }

  writeIndent() {
    const indent = this.indent >= 0 ? this.indent : 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) this.putBreak();
    while (this.column < indent) this.put(" ");
    this.whitespace = true;
    this.indention = true;
  }

  writeIndicator(indicator: string, needWhitespace: boolean, isWhitespace: boolean, isIndention: boolean) {
    if (needWhitespace && !this.whitespace) this.put(" ");
    this.put(indicator);
    this.whitespace = isWhitespace;
    this.indention = this.indention && isIndention;
  }

  writeTag(tag: string) {
    const { handle, suffix } = shortTag(tag);
    if (!this.whitespace) this.put(" ");
    this.put(handle);
    this.put(suffix.replace(/[^0-9A-Za-z\-;/?:@&=+$,_.~*'()[\]]/gu, (ch) => [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")));
    this.whitespace = false;
    this.indention = false;
  }

  emitDocument(root: ReprNode) {
    this.writeIndent();
    this.writeIndicator("---", true, false, false);
    this.emitNode(root, { root: true, mapping: false, simpleKey: false });
    this.writeIndent();
    if (this.openEnded === 2) {
      this.writeIndicator("...", true, false, false);
      this.openEnded = 0;
      this.writeIndent();
    }
  }

  emitNode(node: ReprNode, ctx: { root: boolean; mapping: boolean; simpleKey: boolean }) {
    this.rootContext = ctx.root;
    this.mappingContext = ctx.mapping;
    this.simpleKeyContext = ctx.simpleKey;
    if (node.kind === "scalar") return this.emitScalar(node);
    if (node.kind === "seq") {
      if (this.flowLevel > 0 || node.items.length === 0) return this.emitFlowEmpty("[", "]");
      return this.emitBlockSequence(node.items);
    }
    if (this.flowLevel > 0 || node.pairs.length === 0) return this.emitFlowEmpty("{", "}");
    return this.emitBlockMapping(node.pairs);
  }

  // Psych only reaches flow style for empty collections.
  emitFlowEmpty(open: string, close: string) {
    this.writeIndicator(open, true, true, false);
    this.increaseIndent(true, false);
    this.popIndent();
    this.writeIndicator(close, false, false, false);
  }

  emitBlockSequence(items: ReprNode[]) {
    this.increaseIndent(false, this.mappingContext && !this.indention);
    for (const item of items) {
      this.writeIndent();
      this.writeIndicator("-", true, false, true);
      this.emitNode(item, { root: false, mapping: false, simpleKey: false });
    }
    this.popIndent();
  }

  emitBlockMapping(pairs: [ReprNode, ReprNode][]) {
    this.increaseIndent(false, false);
    for (const [key, value] of pairs) {
      this.writeIndent();
      if (this.checkSimpleKey(key)) {
        this.emitNode(key, { root: false, mapping: true, simpleKey: true });
        this.writeIndicator(":", false, false, false);
      } else {
        this.writeIndicator("?", true, false, true);
        this.emitNode(key, { root: false, mapping: true, simpleKey: false });
        this.writeIndent();
        this.writeIndicator(":", true, false, true);
      }
      this.emitNode(value, { root: false, mapping: true, simpleKey: false });
    }
    this.popIndent();
  }

  checkSimpleKey(node: ReprNode): boolean {
    let length = 0;
    if (node.kind === "scalar") {
      if (analyzeScalar(node.value).multiline) return false;
      const tag = this.emittedTag(node);
      if (tag) length += utf8Length(shortTag(tag).handle) + utf8Length(shortTag(tag).suffix);
      length += utf8Length(node.value);
    } else if (node.kind === "seq") {
      if (node.items.length > 0) return false;
    } else if (node.pairs.length > 0) return false;
    return length <= 128;
  }

  // yaml_emitter_analyze_event: a scalar's tag is written only when neither implicit flag is set.
  emittedTag(node: ScalarNode): string | null {
    return node.tag && !node.plainImplicit && !node.quotedImplicit ? node.tag : null;
  }

  selectStyle(node: ScalarNode, analysis: Analysis): { style: Exclude<Style, "any">; tag: string | null } {
    let tag = this.emittedTag(node);
    const noTag = tag === null;
    let style: Exclude<Style, "any"> = node.style === "any" ? "plain" : node.style;
    if (this.simpleKeyContext && analysis.multiline) style = "double";
    if (style === "plain") {
      if ((this.flowLevel > 0 && !analysis.flowPlainAllowed) || (this.flowLevel === 0 && !analysis.blockPlainAllowed)) style = "single";
      if (node.value.length === 0 && (this.flowLevel > 0 || this.simpleKeyContext)) style = "single";
      if (noTag && !node.plainImplicit) style = "single";
    }
    if (style === "single" && !analysis.singleQuotedAllowed) style = "double";
    if (style === "literal" && (!analysis.blockAllowed || this.flowLevel > 0 || this.simpleKeyContext)) style = "double";
    if (noTag && !node.quotedImplicit && style !== "plain") tag = "!";
    return { style, tag };
  }

  emitScalar(node: ScalarNode) {
    const analysis = analyzeScalar(node.value);
    const { style, tag } = this.selectStyle(node, analysis);
    if (tag) this.writeTag(tag);
    this.increaseIndent(true, false);
    const allowBreaks = !this.simpleKeyContext;
    if (style === "plain") this.writePlain(node.value, allowBreaks);
    else if (style === "single") this.writeSingleQuoted(node.value, allowBreaks);
    else if (style === "double") this.writeDoubleQuoted(node.value, allowBreaks);
    else this.writeLiteral(node.value);
    this.popIndent();
  }

  writePlain(value: string, allowBreaks: boolean) {
    const chars = [...value].map((ch) => ch.codePointAt(0)!);
    if (!this.whitespace && (chars.length > 0 || this.flowLevel > 0)) this.put(" ");
    let spaces = false;
    let breaks = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (isSpace(c)) {
        if (allowBreaks && !spaces && this.column > BEST_WIDTH && !isSpace(chars[i + 1])) this.writeIndent();
        else this.put(" ");
        spaces = true;
      } else if (isBreak(c)) {
        if (!breaks && c === 0x0a) this.putBreak();
        this.writeBreak(c);
        this.indention = true;
        breaks = true;
      } else {
        if (breaks) this.writeIndent();
        this.put(String.fromCodePoint(c));
        this.indention = false;
        spaces = false;
        breaks = false;
      }
    }
    this.whitespace = false;
    this.indention = false;
    if (this.rootContext) this.openEnded = 1;
  }

  writeSingleQuoted(value: string, allowBreaks: boolean) {
    const chars = [...value].map((ch) => ch.codePointAt(0)!);
    this.writeIndicator("'", true, false, false);
    let spaces = false;
    let breaks = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (isSpace(c)) {
        if (allowBreaks && !spaces && this.column > BEST_WIDTH && i !== 0 && i !== chars.length - 1 && !isSpace(chars[i + 1])) this.writeIndent();
        else this.put(" ");
        spaces = true;
      } else if (isBreak(c)) {
        if (!breaks && c === 0x0a) this.putBreak();
        this.writeBreak(c);
        this.indention = true;
        breaks = true;
      } else {
        if (breaks) this.writeIndent();
        const ch = String.fromCodePoint(c);
        this.put(ch === "'" ? "''" : ch);
        this.indention = false;
        spaces = false;
        breaks = false;
      }
    }
    if (breaks) this.writeIndent();
    this.writeIndicator("'", false, false, false);
    this.whitespace = false;
    this.indention = false;
  }

  writeDoubleQuoted(value: string, allowBreaks: boolean) {
    const chars = [...value].map((ch) => ch.codePointAt(0)!);
    this.writeIndicator('"', true, false, false);
    let spaces = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (!isPrintable(c) || c === 0xfeff || isBreak(c) || c === 0x22 || c === 0x5c) {
        this.put("\\");
        const named: Record<number, string> = {
          0x00: "0", 0x07: "a", 0x08: "b", 0x09: "t", 0x0a: "n", 0x0b: "v", 0x0c: "f", 0x0d: "r", 0x1b: "e",
          0x22: '"', 0x5c: "\\", 0x85: "N", 0xa0: "_", 0x2028: "L", 0x2029: "P",
        };
        if (named[c] !== undefined) this.put(named[c]);
        else if (c <= 0xff) this.put(`x${c.toString(16).toUpperCase().padStart(2, "0")}`);
        else if (c <= 0xffff) this.put(`u${c.toString(16).toUpperCase().padStart(4, "0")}`);
        else this.put(`U${c.toString(16).toUpperCase().padStart(8, "0")}`);
        spaces = false;
      } else if (isSpace(c)) {
        if (allowBreaks && !spaces && this.column > BEST_WIDTH && i !== 0 && i !== chars.length - 1) {
          this.writeIndent();
          if (isSpace(chars[i + 1])) this.put("\\");
        } else this.put(" ");
        spaces = true;
      } else {
        this.put(String.fromCodePoint(c));
        spaces = false;
      }
    }
    this.writeIndicator('"', false, false, false);
    this.whitespace = false;
    this.indention = false;
  }

  writeLiteral(value: string) {
    const chars = [...value].map((ch) => ch.codePointAt(0)!);
    this.writeIndicator("|", true, false, false);
    // yaml_emitter_write_block_scalar_hints
    if (isSpace(chars[0]) || isBreak(chars[0])) this.writeIndicator(String(BEST_INDENT), false, false, false);
    this.openEnded = 0;
    let chomp: string | null = null;
    const last = chars.at(-1);
    if (chars.length === 0 || !isBreak(last)) chomp = "-";
    else if (chars.length === 1 || isBreak(chars.at(-2))) chomp = "+";
    if (chomp) this.writeIndicator(chomp, false, false, false);
    if (chomp === "+") this.openEnded = 2;
    this.putBreak();
    this.indention = true;
    this.whitespace = true;
    let breaks = true;
    for (const c of chars) {
      if (isBreak(c)) {
        this.writeBreak(c);
        this.indention = true;
        breaks = true;
      } else {
        if (breaks) this.writeIndent();
        this.put(String.fromCodePoint(c));
        this.indention = false;
        breaks = false;
      }
    }
  }
}

export function psychDump(value: YamlValue): string {
  const emitter = new Emitter();
  emitter.emitDocument(represent(value));
  return emitter.out;
}

// ---------------------------------------------------------------------------------------------
// Loading (Psych::Visitors::ToRuby under safe_load with Symbol permitted)

const SEPARATOR_INDENT = new RegExp(`([${String.fromCharCode(0x2028, 0x2029)}]) +`, "gu");

// JS objects move array-index keys ("1", "42") to the front, so such hashes keep their Ruby
// order as a RubyHash, as do hashes with non-String keys.
export function hashFrom(entries: [YamlValue, YamlValue][]): YamlValue {
  const plain = entries.every(([k]) => typeof k === "string" && !/^(0|[1-9]\d*)$/u.test(k));
  return plain ? (Object.fromEntries(entries) as { [key: string]: YamlValue }) : new RubyHash(entries);
}

function toRuby(node: YamlNode | null | undefined): YamlValue {
  if (node == null) return null;
  if (isMap(node)) {
    const entries: [YamlValue, YamlValue][] = node.items.map((pair) => [toRuby(pair.key as YamlNode), toRuby(pair.value as YamlNode)]);
    return hashFrom(entries);
  }
  if (isSeq(node)) return node.items.map((item) => toRuby(item as YamlNode));
  if (!isScalar(node)) throw new TypeError("Unsupported YAML node");
  let text = String(node.value ?? "");
  // libyaml treats U+2028/U+2029 as line breaks and drops the indentation after them; the
  // `yaml` package reads them as content. Psych only writes them raw in these two styles.
  if (node.type === YamlScalar.QUOTE_SINGLE || node.type === YamlScalar.BLOCK_LITERAL) text = text.replace(SEPARATOR_INDENT, "$1");
  const tag = node.tag;
  if (tag === "tag:yaml.org,2002:str") return text;
  if (tag === "!ruby/symbol" || tag === "!ruby/sym") return new RubySymbol(text);
  if (tag === "!binary" || tag === "tag:yaml.org,2002:binary") return Buffer.from(text, "base64").toString("latin1");
  if (tag === "tag:yaml.org,2002:null") return null;
  if (tag && tag !== "!") throw new DisallowedClass(tag);
  // libyaml reports the non-specific "!" tag as plain-implicit, so Psych still runs the scanner.
  if (node.type !== YamlScalar.PLAIN && tag !== "!") return text;
  const token = tokenize(text);
  switch (token.kind) {
    case "string":
      return token.value;
    case "null":
      return null;
    case "bool":
      return token.value;
    case "int":
      return token.value >= BigInt(Number.MIN_SAFE_INTEGER) && token.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(token.value) : token.value;
    case "float":
      return Number.isInteger(token.value.value) || !Number.isFinite(token.value.value) ? token.value : token.value.value;
    case "symbol":
      return token.value;
    case "time":
      throw new DisallowedClass("Time");
    case "date":
      // ScalarScanner asks the class loader for Date before parsing, so safe_load rejects even invalid dates.
      throw new DisallowedClass("Date");
  }
}

export function psychSafeLoad(text: string): YamlValue {
  const doc = parseDocument(text, { version: "1.1", schema: "failsafe", keepSourceTokens: true, uniqueKeys: false });
  if (doc.errors.length > 0) throw doc.errors[0];
  return toRuby(doc.contents as YamlNode | null);
}

export { RubyFloat, RubySymbol };
