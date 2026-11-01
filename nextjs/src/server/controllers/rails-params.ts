// The Rails/Ruby string and request helpers the authentication controllers lean on: CGI escaping,
// SafeRedirectPathService and the request format. Where Ruby's behaviour depends on a parser that is
// not ported (Mime::Type, Addressable's validations), these answer the cases they can prove and throw
// HandBackToRails for the rest, so Rails serves what the port cannot.
import { isInvalidUriError, rubyUriParseParts } from "../models/concerns/ruby-uri.ts";
import { HandBackToRails } from "./application-controller.ts";
import { isPresent, type RailsRequest } from "./rails-request.ts";

// Ruby's CGI.escape: space as "+", and only A-Z a-z 0-9 _ . - ~ stay as they are.
export function cgiEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

// Ruby's CGI.unescape: "+" is a space and every run of %XX is one UTF-8 byte sequence; a "%" that
// is not followed by two hex digits stays. A run that is not valid UTF-8 makes the later string
// operations raise in Ruby, so it is handed back rather than guessed.
export function cgiUnescape(value: string): string {
  return value.replaceAll("+", " ").replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replaceAll("%", ""), "hex");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new HandBackToRails();
    return text;
  });
}

// CGI.parse(query): "&" and ";" separate pairs; a pair without "=" has a nil value.
export function cgiParse(query: string): Map<string, (string | null)[]> {
  const params = new Map<string, (string | null)[]>();
  for (const pair of query.split(/[&;]/)) {
    const index = pair.indexOf("=");
    const key = cgiUnescape(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : cgiUnescape(pair.slice(index + 1));
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  return params;
}

// Rack's nested query parser turns "a[]=1" and "a[b]=1" into arrays and hashes, which the
// controllers below would then call String methods on.
export function assertFlatQuery(query: string): void {
  if (/(?:^|[&;])[^=&;]*(?:\[|%5B)/i.test(query)) throw new HandBackToRails();
}

// ActionDispatch::Request#referrer
export const referrer = (request: RailsRequest): string | null => request.headers.get("referer");

const BROWSER_LIKE_ACCEPTS = /,\s*\*\/\*|\*\/\*\s*,/;
const JSON_TYPES = new Set(["application/json", "text/x-json", "application/jsonrequest"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml", "*/*"]);

// request.format.ref for the requests these pages see: html (including the browser-like Accept
// lists, which Rails ignores), json, or "other" for a format the port does not model.
export function requestFormat(request: RailsRequest): "html" | "json" | "other" {
  const accept = request.headers.get("accept");
  const xhr = request.headers.get("x-requested-with") === "XMLHttpRequest";
  const usable = (xhr && (isPresent(accept) || request.headers.has("content-type"))) || (isPresent(accept) && !BROWSER_LIKE_ACCEPTS.test(accept));
  if (!usable) return xhr ? "other" : "html";

  const entries = accept!.split(",").map((entry, order) => {
    const [type = "", ...parameters] = entry.trim().split(/\s*;\s*/);
    const quality = parameters.map((parameter) => /^q=([\d.]+)$/.exec(parameter)?.[1]).find((q) => q !== undefined);
    return { type: type.toLowerCase(), quality: quality === undefined ? 1 : Number.parseFloat(quality), order };
  });
  entries.sort((a, b) => b.quality - a.quality || a.order - b.order);
  const first = entries[0]!;
  if (entries.length > 1 && !HTML_TYPES.has(first.type) && !JSON_TYPES.has(first.type)) throw new HandBackToRails();
  if (JSON_TYPES.has(first.type)) return "json";
  return HTML_TYPES.has(first.type) ? "html" : "other";
}

// Addressable::URI::CharacterClasses: what each component keeps when Addressable::URI.escape
// re-encodes a URI.
const AUTHORITY_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@[\]]$/;
const PATH_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/;
const QUERY_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/;

// Addressable::URI.encode_component: every character outside the class, "%" included, becomes its
// UTF-8 bytes as %XX.
const encodeComponent = (value: string, allowed: RegExp) =>
  [...value].map((char) => (allowed.test(char) ? char : Buffer.from(char, "utf8").toString("hex").toUpperCase().replace(/../g, "%$&"))).join("");

// RFC 3986 appendix B, which Addressable::URI.parse splits a URI with.
const URI_SPLIT = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

// SafeRedirectPathService#url: URI.parse(Addressable::URI.escape(CGI.unescape(path).split("#").first)).
function escapedUri(path: string) {
  const unescaped = cgiUnescape(path);
  // Ruby's "###".split("#") is empty, and Addressable raises on the nil that leaves.
  if (/^#*$/.test(unescaped)) throw new HandBackToRails();
  const [, scheme, authority, urlPath = "", query] = URI_SPLIT.exec(unescaped.split("#")[0]!)!;
  // An opaque URI ("javascript:...") has no path, which Ruby's gsub then raises on; any other
  // scheme is Addressable's and URI's to validate.
  if (scheme !== undefined && (authority === undefined || !/^https?$/i.test(scheme))) throw new HandBackToRails();
  const escaped =
    (scheme === undefined ? "" : `${scheme}:`) +
    (authority === undefined ? "" : `//${encodeComponent(authority, AUTHORITY_CLASS)}`) +
    encodeComponent(urlPath, PATH_CLASS) +
    (query === undefined ? "" : `?${encodeComponent(query, QUERY_CLASS)}`);
  try {
    return rubyUriParseParts(escaped);
  } catch (error) {
    // URI::InvalidURIError is a 500 in Rails, which is Rails' to give.
    if (isInvalidUriError(error)) throw new HandBackToRails();
    throw error;
  }
}

// SafeRedirectPathService#process. The normalized path is returned as is when it stays on this host
// (or a subdomain of `rootDomain`, when allowed); otherwise only its path and query.
export function safeRedirectPath(
  input: string | null,
  request: RailsRequest,
  { allowSubdomainHost = true, rootDomain }: { allowSubdomainHost?: boolean; rootDomain: string },
): string {
  let path = input;
  if (path !== null) {
    const separator = path.search(/[?#]/);
    const head = separator === -1 ? path : path.slice(0, separator);
    path = head.replaceAll("\\", "/").replace(/%5[Cc]/g, "/") + (separator === -1 ? "" : path.slice(separator));
  }
  if (!isPresent(path)) return "/";

  const url = escapedUri(path);
  if (url.path === null) throw new HandBackToRails();
  const subdomainHost = url.host !== null && new RegExp(`.*\\.${rootDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(url.host);
  if ((allowSubdomainHost && subdomainHost) || url.host === request.host) return path;

  let relative = url.path.replace(/^\/+/, "/");
  if (relative !== "" && !relative.startsWith("/")) relative = `/${relative}`;
  return url.query === null ? relative : `${relative}?${url.query}`;
}
