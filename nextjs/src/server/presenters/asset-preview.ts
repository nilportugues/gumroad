// Port of the oEmbed and Unsplash half of app/models/asset_preview.rb (`as_json`, `url`, `oembed_url`, `oembed_thumbnail_url`,
// `display_width`, `display_height`). A cover with an upload (blob URL, retina variant, video poster) is not here.
import { psychSafeLoad, type YamlValue } from "../models/concerns/psych.ts";
import { isPlainHash, isRubyFloat, floatValue } from "../models/concerns/ruby-values.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

const DEFAULT_DISPLAY_WIDTH = 670;
const SOURCE = "AssetPreview#as_json for an oEmbed cover Node cannot read exactly";

const handBack = (): never => {
  throw new NotPortedError(SOURCE);
};

// `String#blank?`: [[:space:]] is Unicode White_Space.
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const blank = (value: string): boolean => BLANK.test(value);

// `String#strip` removes ASCII whitespace and, at the end, NUL.
const strip = (value: string): string => value.replace(/^[\t-\r ]+/u, "").replace(/[\t-\r \0]+$/u, "");

// `Integer(value.to_i)` for what an oEmbed document can hold; anything Ruby would raise on or read differently goes to Rails.
function toI(value: YamlValue | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return handBack();
  if (isRubyFloat(value)) {
    const float = floatValue(value);
    return Number.isFinite(float) ? Math.trunc(float) : handBack();
  }
  if (typeof value === "string") {
    const match = /^[\t-\r ]*([+-]?\d+(?:_\d+)*)/u.exec(value);
    const parsed = match ? Number(match[1]!.replaceAll("_", "")) : 0;
    return Number.isSafeInteger(parsed) ? parsed : handBack();
  }
  return handBack();
}

// `safe_url?`
const safeUrl = (url: string): boolean => !blank(url) && !/^[\t-\r ]*(?:javascript|data|vbscript|file):/iu.test(url);

// The first `<iframe>` of the document, read the way libxml2's HTML parser does for plain markup. Comments, raw-text elements and
// character references can make the two parsers disagree, so a document with any of them goes to Rails.
const IFRAME_ATTRIBUTES = String.raw`((?:[\t-\r ]+[^\t-\r "'<>/=]+(?:[\t-\r ]*=[\t-\r ]*(?:"[^"]*"|'[^']*'|[^\t-\r "'<>=\x60]+))?)*)[\t-\r ]*/?>`;
const ATTRIBUTE = /([^\t-\r "'<>/=]+)(?:[\t-\r ]*=[\t-\r ]*(?:"([^"]*)"|'([^']*)'|([^\t-\r "'<>=`]+)))?/gu;

function iframeSrc(html: string): string | null {
  if (
    /<(?:!|\?|\/?(?:script|style|textarea|title|xmp|plaintext|noscript|noembed|noframes|template|svg|math|object|embed|frameset|frame|html|head|body))/iu.test(
      html,
    )
  )
    return handBack();
  const open = /<iframe(?![^\t-\r />])/iu.exec(html);
  if (!open) return null;
  const tag = new RegExp(`^<iframe${IFRAME_ATTRIBUTES}`, "iu").exec(html.slice(open.index));
  if (!tag) return handBack();
  for (const match of tag[1]!.matchAll(ATTRIBUTE)) {
    if (match[1]!.toLowerCase() !== "src") continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) return handBack();
    if (/&(?:#|[A-Za-z][A-Za-z0-9]*;)/u.test(value)) return handBack();
    return value;
  }
  // `iframe[:src].strip` raises NoMethodError on a missing attribute.
  return handBack();
}

function oembedUrl(html: string | null): string | null {
  if (html === null || !/<iframe/iu.test(html)) return null;
  const src = iframeSrc(html);
  if (src === null) return null;
  let url = strip(src);
  if (!safeUrl(url)) return null;
  if (url.startsWith("//")) url = `https:${url}`;
  if (/youtube[^\n]*feature=oembed/u.test(url)) url += "&enablejsapi=1";
  if (/vimeo.com\/video\/\d+$/u.test(url)) url += "?api=1";
  return url;
}

export type OembedDocument = { html: string | null; info: Record<string, YamlValue> };

export function loadOembed(text: string | null): OembedDocument | null {
  if (text === null) return null;
  let value: YamlValue;
  try {
    value = psychSafeLoad(text);
  } catch {
    return handBack();
  }
  if (value === null) return null;
  if (!isPlainHash(value)) return handBack();
  const { html, info } = value as Record<string, YamlValue>;
  if (!isPlainHash(info) || (html !== undefined && html !== null && typeof html !== "string")) return handBack();
  return { html: html ?? null, info: info as Record<string, YamlValue> };
}

// display_width / display_height: an unusable width means "dimensions unknown".
export function displaySize(width: number | null, height: number | null) {
  const displayWidth = width !== null && width > 0 ? Math.min(DEFAULT_DISPLAY_WIDTH, width) : null;
  const displayHeight =
    width !== null && width > 0 && height !== null ? Math.trunc(height * (displayWidth! / width)) : null;
  return { displayWidth, displayHeight };
}

export type CoverRow = { guid: string | null; oembed: string | null; unsplash_url: string | null };

// AssetPreview#as_json for a row without an upload.
export function coverAsJson(row: CoverRow): Record<string, unknown> {
  const oembed = loadOembed(row.oembed);
  const unsplash = row.unsplash_url;
  if (unsplash !== null && blank(unsplash)) return handBack();
  // Neither an Unsplash photo nor an oEmbed document: the type comes from an attached file.
  if (unsplash === null && oembed === null) return handBack();

  let thumbnail: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let url: string | null = unsplash;
  if (oembed) {
    // oembed_thumbnail_url: `thumbnail_url.to_s.strip`
    const raw = oembed.info.thumbnail_url;
    if (raw !== undefined && raw !== null && typeof raw !== "string") return handBack();
    const stripped = strip(raw ?? "");
    thumbnail = safeUrl(stripped) ? stripped : null;
    width = toI(oembed.info.width);
    height = toI(oembed.info.height);
    if (url === null) url = oembedUrl(oembed.html);
  }

  const { displayWidth, displayHeight } = displaySize(width, height);

  return {
    url,
    original_url: url,
    thumbnail,
    id: row.guid,
    type: unsplash !== null ? "unsplash" : "oembed",
    filetype: null,
    width: displayWidth,
    height: displayHeight,
    native_width: width,
    native_height: height,
  };
}

// `Addressable::URI.escape` leaves a URL made only of unreserved characters, sub-delimiters and `:/?#@` as it is; anything it would
// percent-encode or re-encode (spaces, `%`, brackets, non-ASCII) goes to Rails.
const ADDRESSABLE_STABLE_URL =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][A-Za-z0-9\-._~:/?#@!$&'()*+,;=]*)?$/u;

export function addressableEscape(url: string): string {
  if (!ADDRESSABLE_STABLE_URL.test(url)) return handBack();
  return url;
}
