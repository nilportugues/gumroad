// Port of the parts of the Crass gem (CSS Syntax Level 3 tokenizer and parser) that
// app/services/content_moderation/content_extractor.rb calls: Crass::Tokenizer.tokenize,
// Crass.parse_properties and Crass.parse. No CSS parser in package.json exposes tokens with decoded
// escapes, so this is a small spec-following implementation, not a wrapper.
//
// Differences from Crass that could not be checked without the gem (no Ruby in this sandbox):
// a :bad_url token carries the value consumed before the error, and `!important` is left in the
// property's children instead of being lifted into a flag. Neither changes what the extractor reads.

export type CssToken = { node: string; value?: string; raw: string };
export type CssFunction = { node: "function"; name: string; value: CssNode[] };
export type CssSimpleBlock = { node: "simple_block"; value: CssNode[] };
export type CssProperty = { node: "property"; name: string; children: CssNode[] };
export type CssError = { node: "error" };
export type CssNode = CssToken | CssFunction | CssSimpleBlock | CssProperty | CssError;

export type CssStyleRule = { node: "style_rule"; children: (CssProperty | CssError)[] };
export type CssAtRule = { node: "at_rule"; name: string; block: CssToken[] | null };
export type CssRule = CssStyleRule | CssAtRule | CssError;

const REPLACEMENT = "�";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/u.test(c);
const isNewline = (c: string | undefined) => c === "\n";
const isWhitespace = (c: string | undefined) => c === " " || c === "\t" || c === "\n";
const isNameStart = (c: string | undefined) => c !== undefined && (/^[A-Za-z_]$/u.test(c) || c.codePointAt(0)! >= 0x80);
const isNameChar = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";
const isNonPrintable = (c: string | undefined) => {
  if (c === undefined) return false;
  const cp = c.codePointAt(0)!;
  return cp <= 0x8 || cp === 0xb || (cp >= 0xe && cp <= 0x1f) || cp === 0x7f;
};

function preprocess(css: string): string {
  return css.replace(/\r\n?|\f/gu, "\n").replace(/\0/gu, REPLACEMENT);
}

export function tokenize(input: string): CssToken[] {
  const chars = Array.from(preprocess(input));
  const tokens: CssToken[] = [];
  let pos = 0;

  const at = (offset = 0) => chars[pos + offset];
  const validEscapeAt = (offset: number) =>
    chars[pos + offset] === "\\" && chars[pos + offset + 1] !== undefined && !isNewline(chars[pos + offset + 1]);

  function consumeEscape(): string {
    // Called after the backslash is consumed.
    const c = chars[pos];
    if (c === undefined) return REPLACEMENT;
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(chars[pos])) hex += chars[pos++];
      if (isWhitespace(chars[pos])) pos += 1;
      const cp = Number.parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? REPLACEMENT : String.fromCodePoint(cp);
    }
    pos += 1;
    return c;
  }

  function consumeName(): string {
    let name = "";
    for (;;) {
      const c = at();
      if (isNameChar(c)) {
        name += c;
        pos += 1;
      } else if (validEscapeAt(0)) {
        pos += 1;
        name += consumeEscape();
      } else {
        return name;
      }
    }
  }

  const startsIdent = (offset: number): boolean => {
    const first = chars[pos + offset];
    if (first === "-") {
      const second = chars[pos + offset + 1];
      return (
        isNameStart(second) ||
        second === "-" ||
        (second === "\\" && chars[pos + offset + 2] !== undefined && !isNewline(chars[pos + offset + 2]))
      );
    }
    if (isNameStart(first)) return true;
    return first === "\\" && chars[pos + offset + 1] !== undefined && !isNewline(chars[pos + offset + 1]);
  };

  const startsNumber = (): boolean => {
    const first = at();
    if (first === "+" || first === "-") {
      return isDigit(at(1)) || (at(1) === "." && isDigit(at(2)));
    }
    if (first === ".") return isDigit(at(1));
    return isDigit(first);
  };

  function consumeNumeric(): CssToken {
    const start = pos;
    if (at() === "+" || at() === "-") pos += 1;
    while (isDigit(at())) pos += 1;
    if (at() === "." && isDigit(at(1))) {
      pos += 1;
      while (isDigit(at())) pos += 1;
    }
    if ((at() === "e" || at() === "E") && (isDigit(at(1)) || ((at(1) === "+" || at(1) === "-") && isDigit(at(2))))) {
      pos += 2;
      while (isDigit(at())) pos += 1;
    }
    const value = chars.slice(start, pos).join("");
    if (startsIdent(0)) {
      consumeName();
      return { node: "dimension", value, raw: chars.slice(start, pos).join("") };
    }
    if (at() === "%") {
      pos += 1;
      return { node: "percentage", value, raw: chars.slice(start, pos).join("") };
    }
    return { node: "number", value, raw: value };
  }

  function consumeString(quote: string): CssToken {
    const start = pos - 1;
    let value = "";
    for (;;) {
      const c = at();
      if (c === undefined) break;
      if (c === quote) {
        pos += 1;
        break;
      }
      if (isNewline(c)) return { node: "bad_string", value, raw: chars.slice(start, pos).join("") };
      if (c === "\\") {
        if (chars[pos + 1] === undefined) {
          pos += 1;
        } else if (isNewline(chars[pos + 1])) {
          pos += 2;
        } else {
          pos += 1;
          value += consumeEscape();
        }
        continue;
      }
      value += c;
      pos += 1;
    }
    return { node: "string", value, raw: chars.slice(start, pos).join("") };
  }

  function consumeBadUrlRemnants(): void {
    for (;;) {
      const c = at();
      if (c === undefined) return;
      pos += 1;
      if (c === ")") return;
      if (c === "\\" && chars[pos] !== undefined && !isNewline(chars[pos])) consumeEscape();
    }
  }

  function consumeUrl(start: number): CssToken {
    // Called after `url(` and any whitespace are consumed.
    let value = "";
    for (;;) {
      const c = at();
      if (c === undefined || c === ")") {
        if (c === ")") pos += 1;
        return { node: "url", value, raw: chars.slice(start, pos).join("") };
      }
      if (isWhitespace(c)) {
        while (isWhitespace(at())) pos += 1;
        if (at() === ")" || at() === undefined) {
          if (at() === ")") pos += 1;
          return { node: "url", value, raw: chars.slice(start, pos).join("") };
        }
        consumeBadUrlRemnants();
        return { node: "bad_url", value, raw: chars.slice(start, pos).join("") };
      }
      if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { node: "bad_url", value, raw: chars.slice(start, pos).join("") };
      }
      if (c === "\\") {
        if (validEscapeAt(0)) {
          pos += 1;
          value += consumeEscape();
          continue;
        }
        consumeBadUrlRemnants();
        return { node: "bad_url", value, raw: chars.slice(start, pos).join("") };
      }
      value += c;
      pos += 1;
    }
  }

  function consumeIdentLike(): CssToken {
    const start = pos;
    const name = consumeName();
    if (at() !== "(") return { node: "ident", value: name, raw: chars.slice(start, pos).join("") };
    pos += 1;
    if (name.toLowerCase() === "url") {
      let lookahead = 0;
      while (isWhitespace(at(lookahead))) lookahead += 1;
      const next = at(lookahead);
      if (next === '"' || next === "'") return { node: "function", value: name, raw: chars.slice(start, pos).join("") };
      pos += lookahead;
      return consumeUrl(start);
    }
    return { node: "function", value: name, raw: chars.slice(start, pos).join("") };
  }

  while (pos < chars.length) {
    const start = pos;
    const c = chars[pos]!;
    const single = (node: string) => {
      pos += 1;
      tokens.push({ node, raw: c });
    };

    if (c === "/" && at(1) === "*") {
      pos += 2;
      while (pos < chars.length && !(chars[pos] === "*" && chars[pos + 1] === "/")) pos += 1;
      pos = Math.min(pos + 2, chars.length);
    } else if (isWhitespace(c)) {
      while (isWhitespace(at())) pos += 1;
      tokens.push({ node: "whitespace", raw: chars.slice(start, pos).join("") });
    } else if (c === '"' || c === "'") {
      pos += 1;
      tokens.push(consumeString(c));
    } else if (c === "#") {
      if (isNameChar(at(1)) || validEscapeAt(1)) {
        pos += 1;
        const name = consumeName();
        tokens.push({ node: "hash", value: name, raw: chars.slice(start, pos).join("") });
      } else {
        single("delim");
      }
    } else if ("(),:;[]{}".includes(c)) {
      single(c);
    } else if (c === "+" || c === ".") {
      if (startsNumber()) tokens.push(consumeNumeric());
      else single("delim");
    } else if (c === "-") {
      if (startsNumber()) tokens.push(consumeNumeric());
      else if (at(1) === "-" && at(2) === ">") {
        pos += 3;
        tokens.push({ node: "cdc", raw: "-->" });
      } else if (startsIdent(0)) tokens.push(consumeIdentLike());
      else single("delim");
    } else if (c === "<" && at(1) === "!" && at(2) === "-" && at(3) === "-") {
      pos += 4;
      tokens.push({ node: "cdo", raw: "<!--" });
    } else if (c === "@") {
      if (startsIdent(1)) {
        pos += 1;
        const name = consumeName();
        tokens.push({ node: "at_keyword", value: name, raw: chars.slice(start, pos).join("") });
      } else {
        single("delim");
      }
    } else if (c === "\\") {
      if (validEscapeAt(0)) tokens.push(consumeIdentLike());
      else single("delim");
    } else if (isDigit(c)) {
      tokens.push(consumeNumeric());
    } else if (isNameStart(c)) {
      tokens.push(consumeIdentLike());
    } else {
      single("delim");
    }
  }

  return tokens;
}

// A cursor over tokens that groups them into component values.
class Parser {
  index = 0;
  constructor(private readonly tokens: readonly CssToken[]) {}

  get done(): boolean {
    return this.index >= this.tokens.length;
  }

  peek(): CssToken | undefined {
    return this.tokens[this.index];
  }

  next(): CssToken | undefined {
    return this.tokens[this.index++];
  }

  skipWhitespace(): void {
    while (this.peek()?.node === "whitespace") this.index += 1;
  }

  componentValue(): CssNode {
    const token = this.next()!;
    if (token.node === "function") return this.functionNode(token);
    if (token.node === "(" || token.node === "[" || token.node === "{") return this.simpleBlock(token.node);
    return token;
  }

  private functionNode(token: CssToken): CssFunction {
    const value: CssNode[] = [];
    while (!this.done && this.peek()!.node !== ")") value.push(this.componentValue());
    this.next();
    return { node: "function", name: token.value ?? "", value };
  }

  private simpleBlock(open: string): CssSimpleBlock {
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    const value: CssNode[] = [];
    while (!this.done && this.peek()!.node !== close) value.push(this.componentValue());
    this.next();
    return { node: "simple_block", value };
  }

  // The tokens of a `{}` block as a flat list, nested braces included, outer braces excluded.
  rawBlock(): CssToken[] {
    const out: CssToken[] = [];
    let depth = 1;
    while (!this.done) {
      const token = this.next()!;
      if (token.node === "{") depth += 1;
      if (token.node === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(token);
    }
    return out;
  }
}

function declarationList(parser: Parser): (CssProperty | CssError)[] {
  const out: (CssProperty | CssError)[] = [];

  while (!parser.done) {
    const token = parser.peek()!;
    if (token.node === "whitespace" || token.node === ";") {
      parser.next();
    } else if (token.node === "at_keyword") {
      // At-rules inside a declaration list are consumed and dropped.
      parser.next();
      while (!parser.done && parser.peek()!.node !== ";" && parser.peek()!.node !== "{") parser.componentValue();
      if (parser.peek()?.node === "{") {
        parser.next();
        parser.rawBlock();
      }
    } else if (token.node === "ident") {
      const values: CssNode[] = [];
      while (!parser.done && parser.peek()!.node !== ";") values.push(parser.componentValue());
      out.push(declaration(values));
    } else {
      // A nested rule lands here: the whole `selector { ... }` is thrown away, as the spec does.
      while (!parser.done && parser.peek()!.node !== ";") parser.componentValue();
      out.push({ node: "error" });
    }
  }
  return out;
}

function declaration(values: CssNode[]): CssProperty | CssError {
  const nameToken = values[0] as CssToken;
  let index = 1;
  while ((values[index] as CssToken | undefined)?.node === "whitespace") index += 1;
  if ((values[index] as CssToken | undefined)?.node !== ":") return { node: "error" };
  const children = values.slice(index + 1);
  while ((children[0] as CssToken | undefined)?.node === "whitespace") children.shift();
  return { node: "property", name: nameToken.value ?? "", children };
}

// Crass.parse_properties
export function parseProperties(css: string): (CssProperty | CssError)[] {
  return declarationList(new Parser(tokenize(css)));
}

function ruleList(tokens: readonly CssToken[]): CssRule[] {
  const parser = new Parser(tokens);
  const rules: CssRule[] = [];

  while (!parser.done) {
    const token = parser.peek()!;
    if (token.node === "whitespace" || token.node === "cdo" || token.node === "cdc" || token.node === ";") {
      parser.next();
    } else if (token.node === "at_keyword") {
      parser.next();
      while (!parser.done && parser.peek()!.node !== ";" && parser.peek()!.node !== "{") parser.componentValue();
      if (parser.peek()?.node === "{") {
        parser.next();
        rules.push({ node: "at_rule", name: token.value ?? "", block: parser.rawBlock() });
      } else {
        parser.next();
        rules.push({ node: "at_rule", name: token.value ?? "", block: null });
      }
    } else {
      while (!parser.done && parser.peek()!.node !== "{") parser.componentValue();
      if (parser.done) {
        rules.push({ node: "error" });
      } else {
        parser.next();
        rules.push({ node: "style_rule", children: declarationList(new Parser(parser.rawBlock())) });
      }
    }
  }
  return rules;
}

// Crass.parse: a stylesheet's rules.
export function parseStylesheet(css: string): CssRule[] {
  return ruleList(tokenize(css));
}

// Crass::Parser.parse_rules, for the block of an at-rule.
export function parseRules(tokens: readonly CssToken[]): CssRule[] {
  return ruleList(tokens);
}
