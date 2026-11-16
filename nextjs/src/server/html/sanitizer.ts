// ActionView's strip_tags and sanitize as the app configures them (config/application.rb pins
// Rails::HTML4::Sanitizer and the allowed tags and attributes): rails-html-sanitizer 1.6's
// FullSanitizer and SafeListSanitizer's PermitScrubber, over Loofah 2.25's HTML4 fragment.
import { fragmentToHtml, html4Fragment, scrubBottomUp } from "./loofah.ts";
import { type ElementNode, type HtmlNode, insertBefore, removeAttribute, removeNode } from "./libxml2-tree.ts";

// config.action_view.sanitized_allowed_tags / sanitized_allowed_attributes
export const ALLOWED_TAGS: readonly string[] = ["div", "p", "a", "u", "strong", "b", "em", "i", "br"];
export const ALLOWED_ATTRIBUTES: readonly string[] = ["href", "class", "target"];

// `node.before(node.children); node.remove`
function unwrap(node: HtmlNode): void {
  insertBefore(node, node.type === "element" ? [...node.children] : []);
  removeNode(node);
}

// strip_tags(html): TextOnlyScrubber keeps text nodes only, unwrapping everything else.
export function stripTags(html: string): string {
  if (html === "") return html;
  const fragment = html4Fragment(html);
  scrubBottomUp(fragment, (node) => {
    if (node.type !== "text") unwrap(node);
  });
  return fragmentToHtml(fragment);
}

export type SanitizeOptions = { tags?: readonly string[]; attributes?: readonly string[] };

// sanitize(html, tags:, attributes:)
export function sanitize(html: string, options: SanitizeOptions = {}): string {
  if (html === "") return html;
  const tags = new Set(withoutUnpermittable(options.tags ?? ALLOWED_TAGS));
  const attributes = new Set(options.attributes ?? ALLOWED_ATTRIBUTES);
  const fragment = html4Fragment(html);
  scrubBottomUp(fragment, (node) => {
    if (node.type === "cdata") {
      // Loofah::HTML5::Scrub.cdata_escape: <script>/<style> content survives, with &<> escaped.
      const parent = node.parent!;
      const replacement: HtmlNode = { type: "cdata", content: escapeTags(node.content), parent };
      parent.children[parent.children.indexOf(node)] = replacement;
      node.parent = null;
      return;
    }
    if (node.type === "text") return;
    // A comment's node name is "comment", so tags: ["comment"] keeps comments.
    if (node.type === "comment" && tags.has("comment")) return;
    if (node.type !== "element" || !tags.has(node.name)) {
      unwrap(node);
      return;
    }
    scrubAttributes(node, attributes);
  });
  return fragmentToHtml(fragment);
}

// PermitScrubber#validate! drops these (with a warning) whatever the caller asks for.
const withoutUnpermittable = (tags: readonly string[]) => tags.filter((t) => t !== "mglyph" && t !== "malignmark" && t !== "noscript");

const escapeTags = (value: string) => value.replace(/[<>&]/gu, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

// Loofah::HTML5::SafeList::ATTR_VAL_IS_URI
const URI_ATTRIBUTES = new Set(["action", "cite", "href", "longdesc", "poster", "preload", "src", "xlink:href", "xml:base"]);
// Loofah::LibxmlWorkarounds::BROKEN_ESCAPING_ATTRIBUTES (with "name" only on <a>)
const BROKEN_ESCAPING_ATTRIBUTES = new Set(["href", "action", "src", "name"]);

// PermitScrubber#scrub_attributes over a snapshot of the attributes. force_correct_attribute_escaping!
// rewrites every qualifying attribute each time an allowed one is kept, so a later href is checked
// by allowed_uri? after its spaces and quotes have become %20/%22.
function scrubAttributes(element: ElementNode, allowed: Set<string>): void {
  for (const attr of [...element.attributes]) {
    if (!allowed.has(attr.name)) {
      removeAttribute(element, attr.name);
      continue;
    }
    if (URI_ATTRIBUTES.has(attr.name) && !allowedUri(attr.value ?? "")) {
      removeAttribute(element, attr.name);
      continue;
    }
    if (attr.name === "src" && !/[^\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(attr.value ?? "")) {
      removeAttribute(element, attr.name);
    }
    for (const other of element.attributes) {
      if (!BROKEN_ESCAPING_ATTRIBUTES.has(other.name) || (other.name === "name" && element.name !== "a")) continue;
      // Attr#value= stores "" for a valueless attribute, so it then dumps as name="".
      other.value = (other.value ?? "").replace(/[ "]/gu, (c) => (c === " " ? "%20" : "%22"));
    }
  }
  if (element.attributes.some((a) => a.name === "style")) {
    throw new Error("sanitize: an allowed style attribute needs Loofah's CSS scrubber, which is not ported");
  }
}

// Loofah::HTML5::SafeList::ALLOWED_PROTOCOLS / ALLOWED_URI_DATA_MEDIATYPES
const ALLOWED_PROTOCOLS = new Set([
  "afs", "aim", "callto", "data", "ed2k", "fax", "feed", "ftp", "gopher", "http", "https", "irc", "line", "mailto", "modem", "news", "nntp",
  "rsync", "rtsp", "sftp", "sms", "ssh", "tag", "tel", "telnet", "urn", "webcal", "xmpp",
]);
const ALLOWED_DATA_MEDIATYPES = new Set(["image/gif", "image/jpeg", "image/png", "text/css", "text/plain"]);
const CONTROL_CHARACTERS = /[`\u0000-\u0020\u007f\u0080-\u0101]/gu;
const PROTOCOL_SEPARATOR = /:|(&#0*58)|(&#x70)|(&#x0*3a)|(%|&#37;)3A/giu;

// Loofah::HTML5::Scrub.allowed_uri?
export function allowedUri(value: string): boolean {
  const uri = [...cgiUnescapeHtml(value.replace(CONTROL_CHARACTERS, "")).replace(CONTROL_CHARACTERS, "").replaceAll("&colon;", ":")]
    // String#downcase maps each character on its own (no final-sigma rule, unlike toLowerCase).
    .map((c) => c.toLowerCase())
    .join("");
  if (!/^[a-z][a-z0-9+\-.]*:/u.test(uri)) return true;
  const parts = rubySplit(uri, PROTOCOL_SEPARATOR);
  if (!ALLOWED_PROTOCOLS.has(parts[0] ?? "")) return false;
  if (parts[0] === "data" && parts[1] !== undefined) {
    const mediatype = rubySplit(parts[1], /[;,]/gu)[0];
    if (mediatype !== undefined && !ALLOWED_DATA_MEDIATYPES.has(mediatype)) return false;
  }
  return true;
}

// String#split(regexp): captured groups are kept, trailing empty fields dropped.
function rubySplit(value: string, separator: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  for (const match of value.matchAll(separator)) {
    out.push(value.slice(last, match.index));
    for (const group of match.slice(1)) if (group !== undefined) out.push(group);
    last = match.index + match[0].length;
  }
  out.push(value.slice(last));
  while (out.at(-1) === "") out.pop();
  return out;
}

const CODE_POINT_LIMIT = 0x10ffff;

// CGI.unescapeHTML (cgi 0.5.1's C extension) for a UTF-8 string.
export function cgiUnescapeHtml(value: string): string {
  const named: [string, string][] = [["apos;", "'"], ["amp;", "&"], ["quot;", '"'], ["gt;", ">"], ["lt;", "<"]];
  let out = "";
  let i = 0;
  while (i < value.length) {
    const amp = value.indexOf("&", i);
    if (amp === -1) break;
    out += value.slice(i, amp);
    i = amp + 1;
    const entity = named.find(([name]) => value.startsWith(name, i));
    if (entity !== undefined) {
      out += entity[1];
      i += entity[0].length;
      continue;
    }
    const numeric = /^#(?:([0-9]+)|[xX]([0-9a-fA-F]+));/u.exec(value.slice(i));
    if (numeric !== null) {
      const code = numeric[1] !== undefined ? parseDigits(numeric[1], 10) : parseDigits(numeric[2]!, 16);
      if (code < CODE_POINT_LIMIT) {
        // rb_enc_mbcput writes a surrogate's bytes, and the gsub that follows raises on them.
        if (code >= 0xd800 && code <= 0xdfff) throw new Error("invalid byte sequence in UTF-8");
        out += String.fromCodePoint(code);
        i += numeric[0].length;
        continue;
      }
    }
    out += "&";
  }
  return out + value.slice(i);
}

// ruby_scan_digits, saturating: anything at or past the limit is refused either way.
function parseDigits(digits: string, base: number): number {
  let n = 0;
  for (const d of digits) {
    n = n * base + parseInt(d, base);
    if (n > CODE_POINT_LIMIT) return Infinity;
  }
  return n;
}
