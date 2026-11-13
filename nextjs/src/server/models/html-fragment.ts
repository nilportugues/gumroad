// `Nokogiri::HTML.fragment(html).to_html` (SaveContentUpsellsService#from_html), for the messages libxml2 hands back
// byte for byte: well-formed fragments of a few tags. Anything libxml2 would repair or reformat (lists get newlines,
// unclosed tags are closed, entities and URIs are rewritten) throws, so the save goes to Rails before its first write.
// Golden: __fixtures__/save-installment.golden.json ("message:" cases).
import { NotPortedError } from "./user.ts";

const INLINE = new Set(["strong", "em", "b", "i", "u", "s", "a", "code"]);
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote"]);
const VOID = new Set(["br", "hr", "img"]);
const URI_ATTRIBUTES = new Set(["href", "src"]);
const SAFE_URI = /^[A-Za-z0-9\-._~:/?#@!$'()*+,;=%]*(&amp;[A-Za-z0-9\-._~:/?#@!$'()*+,;=%]*)*$/u;
const SAFE_ATTRIBUTE = /^[^"<>&\\\r\n\t]*$/u;
// Characters libxml2 may entity-encode or normalize: carriage returns, C0/C1 controls, no-break and line separators.
// eslint-disable-next-line no-control-regex -- the control characters are the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u00a0\u2028\u2029\ufeff\u200b-\u200f]/u;

// The abandoned cart email's marker (Installment::PRODUCT_LIST_PLACEHOLDER_TAG_NAME): an unknown element, so libxml2 takes
// `<x />` as an empty element and writes it back as an open and close tag.
const PLACEHOLDER = "product-list-placeholder";
const PLACEHOLDER_CLOSE = `</${PLACEHOLDER}>`;

const refuse = (what: string): never => {
  throw new NotPortedError(`a message Nokogiri would rewrite (${what})`, "save_content_upsells_service.rb");
};

function checkText(text: string): void {
  if (UNSAFE_TEXT.test(text)) refuse("control or no-break characters");
  if (/[<>]/u.test(text)) refuse("stray angle bracket");
  const stripped = text.replace(/&(amp|lt|gt);/gu, "");
  if (stripped.includes("&")) refuse("entity");
}

function checkAttributes(source: string): void {
  const attribute = /\s+([a-z][a-z0-9-]*)="([^"]*)"/uy;
  let index = 0;
  const seen = new Set<string>();
  while (index < source.length) {
    attribute.lastIndex = index;
    const match = attribute.exec(source);
    if (match === null) return refuse("attribute syntax");
    const [whole, name, value] = match as unknown as [string, string, string];
    if (seen.has(name)) refuse("duplicate attribute");
    seen.add(name);
    if (URI_ATTRIBUTES.has(name) ? !SAFE_URI.test(value) : !(SAFE_ATTRIBUTE.test(value) && !UNSAFE_TEXT.test(value)))
      refuse("attribute value");
    index += whole.length;
  }
}

// Returns the string Nokogiri would serialize (the input) or throws.
export function nokogiriRoundtrip(html: string | null): string {
  if (html === null) return "";
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/gu;
  const stack: string[] = [];
  let last = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    checkText(html.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match as unknown as [string, string, string, string, string];
    if (name === PLACEHOLDER) {
      if (attributes.trim() !== "" || closing === "/") refuse("placeholder spelling");
      // Only the empty element: anything inside it would nest in libxml2's tree.
      if (selfClosing !== "/" && !html.startsWith(PLACEHOLDER_CLOSE, last)) refuse("placeholder with content");
      if (selfClosing !== "/") {
        last += PLACEHOLDER_CLOSE.length;
        tag.lastIndex = last;
      }
      continue;
    }
    if (name !== name.toLowerCase() || selfClosing === "/") refuse("tag spelling");
    if (!INLINE.has(name) && !BLOCK.has(name) && !VOID.has(name)) refuse(`<${name}>`);
    if (closing === "/") {
      if (attributes !== "" || VOID.has(name) || stack.pop() !== name) refuse("closing tag");
      continue;
    }
    checkAttributes(attributes);
    if (VOID.has(name)) {
      if (name === "br" && attributes !== "") refuse("br attributes");
      continue;
    }
    // libxml2 closes a paragraph at a block and an anchor at another anchor.
    if (BLOCK.has(name) && stack.some((open) => open === "p" || open.startsWith("h")))
      refuse("block inside a paragraph");
    if (name === "a" && stack.includes("a")) refuse("nested anchors");
    stack.push(name);
  }
  checkText(html.slice(last));
  if (stack.length > 0) refuse("unclosed tags");
  if (/<!|<\?/u.test(html)) refuse("markup declaration");
  return html.replace(/<product-list-placeholder\s*\/>/gu, `<${PLACEHOLDER}>${PLACEHOLDER_CLOSE}`);
}
