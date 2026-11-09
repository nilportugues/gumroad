// Port of the string-level helpers in app/services/content_moderation/content_extractor.rb.
// Not ported yet: the HTML and CSS parsing that builds a page's URL list (Nokogiri, Crass), the
// SVG self-containment check (Nokogiri::XML), and product and post image lookup (ActiveStorage,
// S3). `partitionPageImages` takes the SVG check as an argument until that parser exists.
import { isRubyTruthy, rubySplit, rubyStrip } from "./ruby.ts";

export const PERMITTED_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_PAGE_TEXT_LENGTH = 20_000;
export const MAX_PAGE_LINK_TEXT_LENGTH = 5_000;
export const MAX_PAGE_SVG_TEXT_LENGTH = 5_000;
export const MAX_PAGE_IMAGE_URLS = 25;

// Ruby's /\s/ on a string is ASCII whitespace only, unlike JavaScript's.
const RUBY_WHITESPACE = /[ \t\r\n\f\v]/;

// Cuts at the last whitespace at or before `max` characters (code points, as Ruby counts them).
export function truncateOnBoundary(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;

  const cut = chars.slice(0, max);
  for (let index = cut.length - 1; index >= 0; index -= 1) {
    if (RUBY_WHITESPACE.test(cut[index]!)) return cut.slice(0, index).join("");
  }
  return cut.join("");
}

export function isRemoteUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

export function isInlineImageUrl(value: string): boolean {
  return value.toLowerCase().startsWith("data:image/");
}

export type ParsedDataUrl = { contentType: string; base64: boolean; payload: string };

// `;base64` only counts as the last parameter before the comma. Earlier, it is just a parameter.
export function parseDataUrl(url: string): ParsedDataUrl | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;

  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  const parameters = rubySplit(header.replace(/^data:/i, ""), ";").map((part) => part.trim().toLowerCase());
  const base64 = parameters.length > 1 && parameters[parameters.length - 1] === "base64";
  return { contentType: parameters[0] ?? "", base64, payload };
}

// Base64 for `;base64` payloads, otherwise lenient percent-decoding: a `%` without two hex digits
// stays literal, as browsers read it.
export function decodeDataUrlPayload(parsed: ParsedDataUrl): Buffer {
  if (parsed.base64) return Buffer.from(parsed.payload, "base64");

  const bytes = Buffer.from(parsed.payload, "utf8");
  const out: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x25 && index + 2 < bytes.length) {
      const hex = bytes.toString("latin1", index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

// A srcset is comma separated candidates. A data: URL can contain commas, so a split only happens
// before something that looks like the start of a new candidate.
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  for (const candidate of value.split(/,(?=\s*(?:https?:|data:|[^\s,]*\/))/)) {
    const trimmed = rubyStrip(candidate);
    if (trimmed === "") continue;
    const first = trimmed.split(/\s+/)[0];
    if (first) urls.push(first);
  }
  return urls;
}

// The rich-text strings of a description, depth-first, as ContentExtractor#extract_text collects
// them. A node with a truthy "text" member yields that member; otherwise its values are searched.
export function extractRichText(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.flatMap((item) => extractRichText(item));
  if (content !== null && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (isRubyTruthy(record.text)) return Array.isArray(record.text) ? record.text : [record.text];
    return Object.values(record).flatMap((value) => extractRichText(value));
  }
  return [];
}

export function richContentText(descriptions: readonly unknown[]): string {
  return descriptions.flatMap((description) => extractRichText(description)).join(" ");
}

// Seller hosts whose URLs are the seller's own and get their host removed before review.
export type SellerHostSources = {
  subdomain: string | null;
  // Only an active custom domain counts. An unverified one could be an arbitrary off-site URL.
  activeCustomDomain: string | null;
};

export function sellerFirstPartyHosts(seller: SellerHostSources): string[] {
  const hosts = [seller.subdomain, seller.activeCustomDomain]
    .filter((value): value is string => value !== null && value.trim() !== "")
    .map((value) => normalizeHost(value))
    .filter((host): host is string => host !== null);
  return [...new Set(hosts)];
}

// Replaces the scheme and host of each of the seller's own URLs, keeping path, query and
// fragment so a blocklisted term placed there is still reviewed. Other URLs pass through.
export function stripSellerFirstPartyUrls(text: string, hosts: readonly string[]): string {
  if (hosts.length === 0) return text;

  // Case-sensitive scheme, as the Ruby URI pattern is.
  return text.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
    const parts = splitHttpUrl(url);
    if (parts === null || parts.host === null || !hosts.includes(parts.host)) return url;

    const remainder = [
      parts.path === "" ? null : parts.path,
      parts.query === "" ? null : `?${parts.query}`,
      parts.fragment === "" ? null : `#${parts.fragment}`,
    ]
      .filter((piece): piece is string => piece !== null)
      .join("");
    return remainder === "" ? " " : remainder;
  });
}

// `subdomain` may carry a port in dev and test, and the lookup must ignore it.
export function normalizeHost(value: string): string | null {
  const withScheme = value.includes("//") ? value.slice(value.indexOf("//") + 2) : value;
  const host = authorityHost(withScheme.split(/[/?#]/)[0] ?? "");
  return host === null || host === "" ? null : host.toLowerCase();
}

function splitHttpUrl(url: string): { host: string | null; path: string; query: string; fragment: string } | null {
  const match = /^https?:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(url);
  if (match === null) return null;

  const host = authorityHost(match[1] ?? "");
  return {
    host: host === null || host === "" ? null : host.toLowerCase(),
    path: match[2] ?? "",
    query: match[3] ?? "",
    fragment: match[4] ?? "",
  };
}

// The host of `userinfo@host:port`, without the userinfo or the port.
function authorityHost(authority: string): string | null {
  const afterUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  const port = afterUserinfo.lastIndexOf(":");
  return port >= 0 ? afterUserinfo.slice(0, port) : afterUserinfo;
}

// Reshapes data: images. Rasters that are not base64 are re-encoded. A self-contained SVG moves to
// text review within the SVG budget. Everything else stays on the image list, where the classifier
// fails it closed. Returns [image URLs, SVG sources].
export function partitionPageImages(
  urls: readonly string[],
  selfContainedSvg: (source: string) => boolean,
): [string[], string[]] {
  const imageUrls: string[] = [];
  const svgSources: string[] = [];
  let svgBudget = MAX_PAGE_SVG_TEXT_LENGTH;

  for (const url of urls) {
    const parsed = url.toLowerCase().startsWith("data:") ? parseDataUrl(url) : null;
    if (parsed === null) {
      imageUrls.push(url);
    } else if (parsed.contentType === "image/svg+xml") {
      const source = decodeDataUrlPayload(parsed).toString("utf8");
      if (svgSources.includes(source)) continue;

      const cost = Buffer.byteLength(source, "utf8") + (svgSources.length === 0 ? 0 : 1);
      if (cost <= svgBudget && selfContainedSvg(source)) {
        svgSources.push(source);
        svgBudget -= cost;
      } else {
        imageUrls.push(url);
      }
    } else if (PERMITTED_IMAGE_TYPES.includes(parsed.contentType) && !parsed.base64) {
      imageUrls.push(`data:${parsed.contentType};base64,${decodeDataUrlPayload(parsed).toString("base64")}`);
    } else {
      imageUrls.push(url);
    }
  }

  return [[...new Set(imageUrls)], svgSources];
}

