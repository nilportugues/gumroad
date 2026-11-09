// Link#plaintext_description: `Loofah.fragment(description).to_text(encode_special_chars: false).squish`.
// Loofah's :newline_block_elements scrubber replaces each block element (and <br>) with its text
// wrapped in newlines, then takes the fragment's text without comments. After `squish` only the
// word boundaries those newlines create survive, so this walks a parse5 fragment and emits a
// separator at each such element.
//
// Nokogiri parses with libxml2 2.13's HTML4 parser, parse5 with the HTML5 tokenizer, and the two
// decode character references differently (HTML5 knows 2,231 entity names, decodes `&amp` without
// its semicolon and remaps &#128;-&#159; to Windows-1252). So parse5 never sees an `&`: it is
// swapped for a private-use sentinel before parsing and text is decoded here the way libxml2's
// htmlParseReference does it. Tree construction still differs for misnested markup (text
// foster-parented out of a <table>, for one), which can order the text differently.
import { parseFragment } from "parse5";

import { HTML4_ENTITIES } from "./html4-entities.generated.ts";

const LINEBREAKERS = new Set([
  "address", "blockquote", "center", "dir", "div", "dl", "fieldset", "form", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "isindex", "menu", "noframes", "noscript", "ol", "p", "pre", "table", "ul", "article", "aside", "canvas", "dd", "dt",
  "figcaption", "figure", "footer", "header", "hgroup", "li", "main", "nav", "output", "section", "tfoot", "video",
  "frameset", "tbody", "td", "th", "thead", "tr", "br",
]);

// libxml2 2.13 parses only these as raw text, so their `&` stays literal.
const RAW_TEXT = new Set(["script", "style"]);

export const AMP = String.fromCharCode(0xe000);
export const ESCAPED_SENTINEL = String.fromCharCode(0xe001);

type Node = { nodeName: string; value?: string; childNodes?: Node[] };

// IS_CHAR: what htmlParseCharRef accepts.
const isXmlChar = (cp: number) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

const NAME_START = /[\p{L}_:]/u;
const NAME_CHAR = /[\p{L}\p{Nd}\p{Mn}\p{Mc}._:-]/u;

export function restoreSentinels(text: string, decode: boolean): string {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch !== AMP) {
      out += ch;
      continue;
    }
    if (chars[i + 1] === ESCAPED_SENTINEL) {
      out += AMP;
      i++;
      continue;
    }
    if (!decode) {
      out += "&";
      continue;
    }
    // htmlParseCharRef
    if (chars[i + 1] === "#") {
      let j = i + 2;
      const hex = chars[j] === "x" || chars[j] === "X";
      if (hex) j++;
      let value = 0;
      let valid = true;
      while (j < chars.length && chars[j] !== ";") {
        const digit = hex ? /[0-9a-fA-F]/u.test(chars[j]!) : /[0-9]/u.test(chars[j]!);
        if (!digit) break;
        value = value * (hex ? 16 : 10) + Number.parseInt(chars[j]!, 16);
        if (value > 0x10ffff) valid = false;
        j++;
      }
      if (chars[j] === ";") j++;
      if (valid && isXmlChar(value)) out += String.fromCodePoint(value);
      i = j - 1;
      continue;
    }
    // htmlParseEntityRef
    if (chars[i + 1] !== undefined && NAME_START.test(chars[i + 1]!)) {
      let j = i + 1;
      let name = "";
      while (j < chars.length && NAME_CHAR.test(chars[j]!)) name += chars[j++];
      if (chars[j] === ";") {
        const codePoint = HTML4_ENTITIES[name];
        out += codePoint === undefined ? `&${name};` : String.fromCodePoint(codePoint);
        i = j;
      } else {
        out += `&${name}`;
        i = j - 1;
      }
      continue;
    }
    out += "&";
  }
  return out;
}

function textOf(node: Node, out: string[], raw: boolean): void {
  if (node.nodeName === "#comment") return;
  if (node.nodeName === "#text") {
    out.push(restoreSentinels(node.value ?? "", !raw));
    return;
  }
  const breaks = LINEBREAKERS.has(node.nodeName);
  if (breaks) out.push("\n");
  for (const child of node.childNodes ?? []) textOf(child, out, RAW_TEXT.has(node.nodeName));
  if (breaks && node.nodeName !== "br") out.push("\n");
}

// [[:space:]] on a UTF-8 string (Unicode White_Space).
const RUBY_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_RUN = new RegExp(`[${RUBY_SPACE}]+`, "gu");
const ALL_SPACE = new RegExp(`^[${RUBY_SPACE}]*$`, "u");

// ActiveSupport String#squish: collapse [[:space:]] runs to one space, then strip ASCII whitespace and NUL.
export function squish(value: string): string {
  return value.replace(SPACE_RUN, " ").replace(/^[\t\n\v\f\r \0]+|[\t\n\v\f\r \0]+$/gu, "");
}

// `Loofah.fragment(html).to_text(encode_special_chars: false)` before any whitespace handling.
export function loofahText(html: string): string {
  const guarded = html.replaceAll(AMP, `${AMP}${ESCAPED_SENTINEL}`).replaceAll("&", AMP);
  const fragment = parseFragment(guarded, { scriptingEnabled: false }) as unknown as Node;
  const out: string[] = [];
  for (const child of fragment.childNodes ?? []) textOf(child, out, false);
  return out.join("");
}

export function plaintextDescription(description: string | null | undefined): string {
  if (description === null || description === undefined || ALL_SPACE.test(description)) return "";
  return squish(loofahText(description));
}
