// Port of premailer 1.29's HtmlToPlainText#convert_to_text, with htmlentities 4.3.4's decoder.
import { UnsupportedHtmlError } from "./html.ts";
import { split, strip } from "./ruby.ts";

const S = "[ \\t\\n\\v\\f\\r]";

// HTMLEntities.new.decode (xhtml1 flavor). Its input is libxml2 output, which escapes every "&" in
// text, so only these names can occur; any other is refused rather than guessed.
const XHTML1_NAMES: Record<string, number> = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160 };

function decodeEntities(text: string): string {
  return text.replace(/&(?:([a-z][a-z0-9]{1,7})|#([0-9]{1,7})|#x([0-9a-f]{1,6}));/gi, (whole, name?: string, dec?: string, hex?: string) => {
    if (name !== undefined) {
      const code = XHTML1_NAMES[name];
      if (code !== undefined) return String.fromCodePoint(code);
      if (name === name.toLowerCase()) throw new UnsupportedHtmlError(`plain-text entity ${whole}`);
      return whole;
    }
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    if (code > 0x10ffff) throw new UnsupportedHtmlError(`character reference ${whole}`);
    return String.fromCodePoint(code);
  });
}

const charLength = (value: string) => [...value].length;

// ActionView's word_wrap, as premailer copies it.
function wordWrap(text: string, lineLength: number): string {
  const wrap = new RegExp(`([^\\n]{1,${lineLength}})(${S}+|$)`, "gu");
  return split(text, "\n")
    .map((line) => (charLength(line) > lineLength ? strip(line.replace(wrap, "$1\n")) : line))
    .join("\n");
}

function asciiCaseEqual(a: string, b: string): boolean {
  return a.replace(/[A-Z]/gu, (c) => c.toLowerCase()) === b.replace(/[A-Z]/gu, (c) => c.toLowerCase());
}

export function convertToText(html: string, lineLength = 65): string {
  let txt = html;
  txt = txt.replace(/<!-- start text\/html -->[\s\S]*?<!-- end text\/html -->/gu, "");
  txt = txt.replace(/<img[^>]+?alt="([^"]*)"[^>]*>/giu, "$1");
  txt = txt.replace(/<img[^>]+?alt='([^']*)'[^>]*>/giu, "$1");
  txt = txt.replace(/<script[\s\S]*?\/script>/gu, "");

  txt = txt.replace(new RegExp(`<a${S}+([^>]+)>([\\s\\S]*?)<\\/a>`, "giu"), (s: string, _attrs: string, inner: string) => {
    const text = strip(inner);
    const match = /href=(['"])(?:mailto:)?([^\n]+?)\1/u.exec(s);
    const href = match ? match[2]! : null;
    if (text === "") return "";
    if (href === null || asciiCaseEqual(strip(text), strip(href))) return strip(text);
    return `${strip(text)} ( ${strip(href)} )`;
  });

  txt = txt.replace(/(<\/h[1-6]>)/giu, "\n$1");
  txt = txt.replace(new RegExp(`${S}*<h([1-6]+)[^>]*>${S}*([^\\n]*)${S}*<\\/h[1-6]+>`, "giu"), (_s: string, level: string, inner: string) => {
    const hlevel = Number.parseInt(level, 10);
    let htext = inner.replace(new RegExp(`<br${S}*\\/?>`, "giu"), "\n").replace(/<\/?[^>]*>/giu, "");
    let hlength = 0;
    for (const line of htext.match(/[^\n]*\n|[^\n]+$/gu) ?? []) hlength = Math.max(hlength, charLength(strip(line)));
    hlength = Math.min(hlength, lineLength);
    if (hlevel === 1) htext = `${"*".repeat(hlength)}\n${htext}\n${"*".repeat(hlength)}`;
    else if (hlevel === 2) htext = `${"-".repeat(hlength)}\n${htext}\n${"-".repeat(hlength)}`;
    else htext = `${htext}\n${"-".repeat(hlength)}`;
    return `\n\n${htext}\n\n`;
  });

  txt = txt.replace(new RegExp(`(<\\/span>)${S}+(<span)`, "giu"), "$1 $2");
  txt = txt.replace(new RegExp(`${S}*(<li[^>]*>)${S}*`, "giu"), "* ");
  txt = txt.replace(new RegExp(`<\\/li>${S}*(?![\\n])`, "giu"), "\n");
  txt = txt.replace(/<\/p>/giu, "\n\n");
  txt = txt.replace(/<br[/ ]*>/giu, "\n");
  txt = txt.replace(/<\/?[^>]*>/gu, "");
  txt = decodeEntities(txt);
  txt = wordWrap(txt, lineLength);
  txt = txt.replace(/\r\n?/gu, "\n");
  txt = txt.replace(/[ \t]* +[ \t]*/gu, " ");
  txt = txt.replace(/\n[ \t]+/gu, "\n");
  txt = txt.replace(/[ \t]+\n/gu, "\n");
  txt = txt.replace(/[\n]{3,}/gu, "\n\n");
  txt = txt.replace(/\(([ \n])(http[^)]+)([\n ])\)/gu, (_s: string, a: string, url: string, b: string) => `${a === "\n" ? a : ""}( ${url} )${b === "\n" ? a : ""}`);
  return strip(txt);
}
