// Port of Ai::PageSanitizer (app/services/ai/page_sanitizer.rb): the allowlist scrub applied to seller custom HTML, over the Loofah
// fragment that html/loofah.ts reproduces. It guards HTML injected into pages, so it answers only what it can prove byte-identical to
// Ruby and throws NotPortedError (a hand-back to Rails before any write) for everything else:
//   - markup libxml2 nests deeper than the parser port supports (Nokogiri's own depth limit),
//   - element and attribute names outside ASCII (Ruby's String#downcase against JS's) or an attribute named like an array index (a JS
//     object would reorder the report's `attrs` hash),
//   - a script `src` or stylesheet `href` that starts like an https URL but is not in the plain shape Ruby's URI.parse is known to accept,
//   - a percent-decoded or entity-decoded URL attribute that is not valid UTF-8, where Ruby raises ArgumentError.
import {
  type ElementNode,
  type HtmlNode,
  type ParentNode,
  getAttribute,
  insertBefore,
  removeAttribute,
  removeNode,
  setAttribute,
  UnsupportedHtmlError,
} from "../html/libxml2-tree.ts";
import { fragmentToHtml, html4Fragment } from "../html/loofah.ts";
import { cgiUnescapeHtml } from "../html/sanitizer.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

export const ALLOWED_SCRIPT_HOSTS: readonly string[] = ["cdn.tailwindcss.com", "cdn.jsdelivr.net", "unpkg.com"];
export const ALLOWED_STYLESHEET_HOSTS: readonly string[] = ["fonts.googleapis.com", "fonts.bunny.net"];

export const IFRAME_REMOVAL_REASON =
  'embeds can\'t load on custom pages; link to the video or page with target="_blank" instead';

export const ALLOWED_TAGS: readonly string[] = (
  "a abbr address area article aside audio b bdi bdo blockquote br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em " +
  "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li link main map mark menu meter nav ol optgroup option " +
  "output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea " +
  "tfoot th thead time tr track u ul var video wbr path circle rect line polyline polygon ellipse g defs lineargradient radialgradient stop clippath"
).split(" ");

export const ALLOWED_ATTRIBUTES: readonly string[] = (
  "accept accept-charset alt aria-describedby aria-hidden aria-label aria-labelledby aria-live aria-pressed async autocomplete autofocus autoplay checked cite class " +
  "charset cols colspan content contenteditable controls coords crossorigin datetime defer dir disabled download draggable enctype " +
  "fill for form height hidden href id kind label lang loading loop max maxlength media method min minlength multiple muted name pattern placeholder playsinline poster " +
  "preserveaspectratio readonly referrerpolicy rel required role rows rowspan scope selected shape size sizes span spellcheck src srcset step style tabindex target title translate type " +
  "value viewbox width xmlns x y x1 y1 x2 y2 cx cy r rx ry d stroke stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule clip-path points transform offset stop-color " +
  "stop-opacity"
).split(" ");

const URL_ATTRIBUTES = new Set(["action", "href", "poster", "src"]);
const SRCSET_ATTRIBUTES = new Set(["srcset"]);
const NAVIGABLE_URL_ATTRIBUTES = new Set(["action", "href"]);
const SAFE_DATA_URI_PREFIXES = ["data:image/", "data:video/", "data:audio/", "data:font/"];
const WRAPPER_TAGS = new Set(["html", "head", "body"]);
export const MAX_REPORT_ENTRIES = 100;

const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);
const ALLOWED_ATTRIBUTE_SET = new Set(ALLOWED_ATTRIBUTES);

export type RemovedTag = { tag: string; attrs: Record<string, string>; reason: string };
export type RemovedAttribute = { tag: string; attribute: string; value: string; reason: string };
export type SanitizeReport = {
  removed_tags: RemovedTag[];
  removed_attributes: RemovedAttribute[];
  total_removed: number;
  truncated: boolean;
};
export type SanitizeResult = { html: string; report: SanitizeReport };

// `String#blank?`: [[:space:]] is Unicode White_Space.
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
export const rubyBlank = (value: string | null | undefined): boolean => value == null || BLANK.test(value);

// `String#strip`: ASCII whitespace and NUL on both ends.
const rubyStrip = (value: string): string => value.replace(/^[\0\t-\r ]+|[\0\t-\r ]+$/gu, "");
// `String#casecmp`: ASCII-only folding, unlike toLowerCase (the Kelvin sign is a "k").
const asciiLower = (value: string): string => value.replace(/[A-Z]/gu, (c) => c.toLowerCase());
// eslint-disable-next-line no-control-regex -- [[:cntrl:]] is the Cc category
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;
const stripControlChars = (value: string): string => value.replace(CONTROL_CHARS, "");
const NON_ASCII = /\P{ASCII}/u;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

// Nokogiri's Node#[] reads a valueless attribute as an empty string.
const attr = (node: ElementNode, name: string): string | undefined => {
  const value = getAttribute(node, name);
  return value === undefined ? undefined : (value ?? "");
};

const emptyReport = (): SanitizeReport => ({
  removed_tags: [],
  removed_attributes: [],
  total_removed: 0,
  truncated: false,
});
export { emptyReport };

function reportCapReached(report: SanitizeReport): boolean {
  return report.removed_tags.length + report.removed_attributes.length >= MAX_REPORT_ENTRIES;
}

function recordRemovedTag(report: SanitizeReport, node: ElementNode, reason: string): void {
  report.total_removed += 1;
  if (reportCapReached(report)) return;
  const attrs: Record<string, string> = {};
  for (const a of node.attributes) {
    if (ARRAY_INDEX.test(a.name))
      throw new NotPortedError("Ai::PageSanitizer reporting an attribute named like an array index");
    attrs[a.name] = stripControlChars(a.value ?? "");
  }
  report.removed_tags.push({ tag: node.name, attrs, reason });
}

function recordRemovedAttribute(
  report: SanitizeReport,
  node: ElementNode,
  name: string,
  value: string,
  reason: string,
): void {
  report.total_removed += 1;
  if (reportCapReached(report)) return;
  report.removed_attributes.push({ tag: node.name, attribute: name, value: stripControlChars(value), reason });
}

// ---------------------------------------------------------------------------------------------
// URL checks

// URI.parse(url) succeeding with scheme https, for the plain shape only: userinfo, a registered name, an optional port, a path of
// RFC 3986 segments, a printable-ASCII query and a fragment of RFC 3986 characters. Returns the host, or undefined for a string Ruby
// rejects or accepts with another scheme. A string that starts like https but fits no known shape throws: Ruby may go either way.
const PCT = "%[0-9A-Fa-f]{2}";
const SEGMENT = `(?:${PCT}|[A-Za-z0-9\\-._~!$&'()*+,;=:@])*`;
const HTTPS_URL = new RegExp(
  `^https://(?:(?:${PCT}|[A-Za-z0-9\\-._~!$&'()*+,;=:])*@)?((?:${PCT}|[A-Za-z0-9\\-._~!$&'()*+,;=])*)(?::[0-9]*)?(?:/${SEGMENT})*(?:\\?[ -"$-~]*)?(?:#(?:${PCT}|[A-Za-z0-9\\-._~!$&'()*+,;=:@/?])*)?$`,
  "iu",
);
const STARTS_LIKE_HTTPS = /^https:/iu;

// URI.parse raises InvalidURIError for sure when the part before the query holds a character no authority or path may hold (or a
// "%" without two hex digits), or when the fragment holds one no fragment may hold. The query accepts nearly anything but "#".
const BAD_BEFORE_QUERY = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/%[\]]|%(?![0-9A-Fa-f]{2})/u;
const BAD_IN_FRAGMENT = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]|%(?![0-9A-Fa-f]{2})/u;
function rejectedByUriParser(url: string): boolean {
  const queryOrFragment = url.search(/[?#]/u);
  const beforeQuery = queryOrFragment === -1 ? url : url.slice(0, queryOrFragment);
  if (BAD_BEFORE_QUERY.test(beforeQuery)) return true;
  // The authority, with no IPv6 literal: at most one "@", and a port of digits only after the host.
  const authority = /^[^:]*:\/\/([^/]*)/u.exec(beforeQuery)?.[1] ?? "";
  if (!authority.includes("[")) {
    const at = authority.split("@");
    if (at.length > 2 || !/^[^:]*(?::[0-9]*)?$/u.test(at.at(-1)!)) return true;
  }
  const hash = url.indexOf("#");
  return hash !== -1 && BAD_IN_FRAGMENT.test(url.slice(hash + 1));
}

function httpsHost(url: string): string | undefined {
  if (!STARTS_LIKE_HTTPS.test(url)) {
    // Any other scheme, or no scheme, or a string URI.parse rejects (leading whitespace included), is "not https" either way.
    return undefined;
  }
  // Without "//" there is no authority: a path-only URI has no host, and anything else is an error.
  if (!/^https:\/\//iu.test(url) || rejectedByUriParser(url)) return undefined;
  const match = HTTPS_URL.exec(url);
  if (match === null) throw new NotPortedError("Ai::PageSanitizer reading a URL URI.parse may accept or reject");
  return asciiLower(match[1] ?? "");
}

function httpsHostIn(url: string | undefined, hosts: readonly string[]): boolean {
  if (rubyBlank(url)) return false;
  const host = httpsHost(url!);
  return host !== undefined && hosts.includes(host);
}

// Addressable::URI.unencode_component: every %XX becomes its byte, and the result is read as UTF-8.
const UTF8 = new TextDecoder("utf-8", { fatal: true });
function percentDecode(value: string): string {
  if (!value.includes("%")) return value;
  const bytes: number[] = [];
  const raw = Buffer.from(value, "utf8");
  for (let i = 0; i < raw.length; i += 1) {
    const hex = raw[i] === 0x25 ? raw.subarray(i + 1, i + 3).toString("latin1") : "";
    if (hex.length === 2 && /^[0-9a-fA-F]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(raw[i]!);
    }
  }
  try {
    return UTF8.decode(Uint8Array.from(bytes));
  } catch {
    // The next gsub on the broken string raises ArgumentError in Rails.
    throw new NotPortedError("Ai::PageSanitizer decoding a URL into invalid UTF-8");
  }
}

const MAX_DECODE_PASSES = 10;
function normalizeUrl(value: string): string {
  let decoded: string;
  try {
    decoded = cgiUnescapeHtml(value);
  } catch {
    throw new NotPortedError("Ai::PageSanitizer decoding a character reference into a surrogate");
  }
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = percentDecode(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return (
    decoded
      // eslint-disable-next-line no-control-regex -- [[:space:]] and C0 controls, as in Ruby
      .replace(/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0000-\u001f]+/gu, "")
      .toLowerCase()
  );
}

const startsWithJavascript = (normalized: string) => normalized.startsWith("javascript:");
const safeDataUri = (normalized: string) => SAFE_DATA_URI_PREFIXES.some((prefix) => normalized.startsWith(prefix));

function dangerousUrlReason(value: string): string {
  return startsWithJavascript(normalizeUrl(value)) ? "javascript: URL blocked" : "data: URL blocked";
}

function dangerousUrlAttribute(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase();
  if (!URL_ATTRIBUTES.has(normalizedName)) return false;
  const normalized = normalizeUrl(value);
  if (startsWithJavascript(normalized)) return true;
  if (!normalized.startsWith("data:")) return false;
  return NAVIGABLE_URL_ATTRIBUTES.has(normalizedName) || !safeDataUri(normalized);
}

function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  for (const candidate of value.split(/[\t-\r ]*,[\t-\r ]*/u)) {
    const stripped = rubyStrip(candidate);
    if (stripped === "") continue;
    const end = stripped.search(/[\t-\r ]/u);
    const url = end === -1 ? stripped : stripped.slice(0, end);
    if (!rubyBlank(url)) urls.push(url);
  }
  return urls;
}

function srcsetUrlRemovalReason(value: string): string | null {
  const normalized = srcsetUrls(value).map(normalizeUrl);
  if (normalized.some(startsWithJavascript)) return "javascript: URL blocked";
  if (normalized.some((url) => url.startsWith("data:") && !safeDataUri(url))) return "data: URL blocked";
  return null;
}

function unsafeTargetReason(value: string): string | null {
  return ["_parent", "_top", "_unfencedtop"].includes(rubyStrip(value).toLowerCase())
    ? "target navigation blocked"
    : null;
}

function allowedAttribute(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("data-") ||
    normalized.startsWith("aria-") ||
    /^on[a-z][a-z0-9]*$/u.test(normalized) ||
    ALLOWED_ATTRIBUTE_SET.has(normalized)
  );
}

function attributeRemovalReason(name: string, value: string): string | null {
  if (!allowedAttribute(name)) return "attribute not in allowlist";
  const normalized = name.toLowerCase();
  if (normalized === "target") return unsafeTargetReason(value);
  if (SRCSET_ATTRIBUTES.has(normalized)) return srcsetUrlRemovalReason(value);
  if (dangerousUrlAttribute(name, value)) return dangerousUrlReason(value);
  return null;
}

function allowedStylesheetLink(node: ElementNode): boolean {
  const rel = attr(node, "rel") ?? "";
  if (
    !rel
      .toLowerCase()
      .split(/[\t-\r ]+/u)
      .includes("stylesheet")
  )
    return false;
  return httpsHostIn(attr(node, "href"), ALLOWED_STYLESHEET_HOSTS);
}

// ---------------------------------------------------------------------------------------------
// The scrub

function scrubNode(node: HtmlNode | ParentNode, report: SanitizeReport): void {
  if (node.type === "element" || node.type === "fragment" || node.type === "document") {
    for (const child of [...node.children]) scrubNode(child, report);
  }
  if (node.type !== "element") return;

  if (NON_ASCII.test(node.name) || node.attributes.some((a) => NON_ASCII.test(a.name))) {
    throw new NotPortedError("Ai::PageSanitizer reading a non-ASCII element or attribute name");
  }
  // Nokogiri re-sets a fragment root's prefixed attributes with Node#[]=, which turns `xml:lang` into the namespaced attribute
  // `lang`: the allowlist then judges its local name, and remove_attribute finds it by that name among the plain ones.
  if (node.attributes.some((a) => a.name.startsWith("xml:"))) {
    throw new NotPortedError("Ai::PageSanitizer reading an xml: prefixed attribute");
  }

  if (WRAPPER_TAGS.has(node.name)) {
    insertBefore(node, [...node.children]);
    removeNode(node);
    return;
  }

  if (node.name === "meta" && asciiLower(attr(node, "http-equiv") ?? "") === "refresh") {
    recordRemovedTag(report, node, "meta refresh blocked");
    removeNode(node);
    return;
  }

  if (node.name === "iframe") {
    recordRemovedTag(report, node, IFRAME_REMOVAL_REASON);
    removeNode(node);
    return;
  }

  if (!ALLOWED_TAG_SET.has(node.name.toLowerCase())) {
    recordRemovedTag(report, node, "tag not in allowlist");
    removeNode(node);
    return;
  }

  if (node.name === "script") {
    const src = attr(node, "src");
    if (!rubyBlank(src) && !httpsHostIn(src, ALLOWED_SCRIPT_HOSTS)) {
      recordRemovedTag(report, node, "script src host not allowed");
      removeNode(node);
      return;
    }
  }

  if (node.name === "link" && !allowedStylesheetLink(node)) {
    recordRemovedTag(report, node, "link must be rel=stylesheet on an allowed host");
    removeNode(node);
    return;
  }

  if (node.name === "form") {
    const action = attr(node, "action");
    if (!rubyBlank(action)) {
      recordRemovedAttribute(report, node, "action", action!, "form action removed");
      removeAttribute(node, "action");
    }
  }

  for (const attribute of [...node.attributes]) {
    const value = attribute.value ?? "";
    const reason = attributeRemovalReason(attribute.name, value);
    if (reason === null) continue;
    recordRemovedAttribute(report, node, attribute.name, value, reason);
    removeAttribute(node, attribute.name);
  }

  if (node.name === "a" && asciiLower(rubyStrip(attr(node, "target") ?? "")) === "_blank") {
    setAttribute(node, "rel", "noopener noreferrer");
  }
}

export function sanitizeWithReport(html: string | null | undefined): SanitizeResult {
  if (rubyBlank(html)) return { html: "", report: emptyReport() };
  let fragment;
  try {
    fragment = html4Fragment(html!);
  } catch (error) {
    if (error instanceof UnsupportedHtmlError)
      throw new NotPortedError(`Ai::PageSanitizer parsing this markup (${error.message})`);
    throw error;
  }
  const report = emptyReport();
  scrubNode(fragment, report);
  report.truncated = report.total_removed > report.removed_tags.length + report.removed_attributes.length;
  return { html: fragmentToHtml(fragment), report };
}

export function sanitize(html: string | null | undefined): string {
  return sanitizeWithReport(html).html;
}
