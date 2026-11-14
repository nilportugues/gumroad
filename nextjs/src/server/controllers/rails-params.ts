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
    .replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

// Ruby's CGI.unescape: "+" is a space and every run of %XX is one UTF-8 byte sequence; a "%" that
// is not followed by two hex digits stays. A run that is not valid UTF-8 makes the later string
// operations raise in Ruby, so it is handed back rather than guessed.
export function cgiUnescape(value: string): string {
  return value.replaceAll("+", " ").replace(/(?:%[0-9a-fA-F]{2})+/gu, (run) => {
    const bytes = Buffer.from(run.replaceAll("%", ""), "hex");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new HandBackToRails();
    return text;
  });
}

// CGI.parse(query): "&" and ";" separate pairs; a pair without "=" has a nil value.
export function cgiParse(query: string): Map<string, (string | null)[]> {
  const params = new Map<string, (string | null)[]>();
  for (const pair of query.split(/[&;]/u)) {
    const index = pair.indexOf("=");
    const key = cgiUnescape(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : cgiUnescape(pair.slice(index + 1));
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  return params;
}

// Rack's nested query parser turns "a[]=1" and "a[b]=1" into arrays and hashes, which the
// controllers below would then call String methods on.
// `arrayKeys` are the names whose `name[]` form the caller reads itself (see queryParamStrings).
export function assertFlatQuery(query: string, arrayKeys: string[] = []): void {
  if (arrayKeys.length > 0 && query.includes(";")) throw new HandBackToRails();
  const rest = query
    .split("&")
    .filter((pair) => !arrayKeys.some((key) => new RegExp(`^${key}(?:\\[|%5B)(?:\\]|%5D)(?:=|$)`, "iu").test(pair)))
    .join("&");
  if (/(?:^|[&;])[^=&;]*(?:\[|%5B)/iu.test(rest)) throw new HandBackToRails();
}

// Rack 3.2's Rack::QueryParser#parse_nested_query, for a caller that reads only which top-level keys exist and whether a flat one has a
// value (`a` has none, `a=` has an empty string). `a[]`, `a[b]` and `a[b][c]` hang a list or a hash of any depth from the key. Later pairs
// of a flat name overwrite whatever the name held. A "%" without two hex digits after it makes Rack raise InvalidParameterError, which
// CatchBadRequestErrors answers with a 400 (isRackBadRequest, a hand-back for a caller that has not recorded that answer). A name used as two
// kinds of value raises ParameterTypeError, which Rack::Attack's `invalid_params` rule does not rescue: what it counts is not recorded.
export type RackTopLevelParam = { nested: false; value: string | null } | { nested: true };

// A hand-back tagged with what Rack raised. Not a subclass: application-controller imports rack-attack, which imports this module, so
// `extends HandBackToRails` would run before the class exists.
type RackErrorKind = "bad-request" | "parameter-type";
const rackError = (kind: RackErrorKind, message: string) => Object.assign(new HandBackToRails(message), { rackKind: kind });
export const isRackBadRequest = (error: unknown): boolean =>
  error instanceof HandBackToRails && (error as { rackKind?: RackErrorKind }).rackKind === "bad-request";

// Rack's default param_depth_limit is not recorded, so a deeper name goes to Rails.
const RACK_DEPTH_LIMIT = 32;
// Rack's pair and byte limits (RACK_QUERY_PARSER_PARAMS_LIMIT, _BYTESIZE_LIMIT) raise past these; a query this size goes to Rails.
const RACK_PARAMS_LIMIT = 4096;
const RACK_BYTESIZE_LIMIT = 4_194_304;

type RackValue = string | null | RackValue[] | RackHash;
type RackHash = Map<string, RackValue>;

// URI.decode_www_form_component: "+" is a space, "%XX" a byte, any other "%" raises.
function rackUnescape(text: string): string {
  if (/%(?![0-9a-fA-F]{2})/u.test(text)) throw rackError("bad-request", "a query string with an invalid percent escape");
  const bytes = Buffer.from(text.replaceAll("+", " "), "latin1");
  const decoded: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte === 0x25) {
      decoded.push(Number.parseInt(bytes.toString("latin1", index + 1, index + 3), 16));
      index += 2;
    } else decoded.push(byte);
  }
  return Buffer.from(decoded).toString("utf8");
}

const isHash = (value: RackValue | undefined): value is RackHash => value instanceof Map;

// The `[]` and `[a]` keys of a nested name (`params_hash_has_key?`).
function rackHashHasKey(hash: RackHash, key: string): boolean {
  if (key.includes("[]")) return false;
  let current: RackValue | undefined = hash;
  for (const part of key.split(/[[\]]+/u)) {
    if (part === "") continue;
    if (!isHash(current) || !current.has(part)) return false;
    current = current.get(part);
  }
  return true;
}

function wrongType(expected: "Array" | "Hash"): never {
  throw rackError("parameter-type", `a query parameter used as a flat value and as ${expected === "Array" ? "a list" : "a hash"}`);
}

// Rack::QueryParser#_normalize_params. Returns what Ruby returns: the params, `[v]` for a bare "[]" below the top, nil for an empty key.
function normalizeParams(params: RackHash, name: string, v: string | null, depth: number): RackHash | RackValue[] | undefined {
  if (depth >= RACK_DEPTH_LIMIT) throw new HandBackToRails("a query parameter nested too deeply");
  let key: string;
  let after: string;
  if (depth === 0) {
    const start = name.indexOf("[", 1);
    key = start === -1 ? name : name.slice(0, start);
    after = start === -1 ? "" : name.slice(start);
  } else if (name.startsWith("[]")) {
    key = "[]";
    after = name.slice(2);
  } else if (name.startsWith("[") && name.indexOf("]", 1) !== -1) {
    const close = name.indexOf("]", 1);
    key = name.slice(1, close);
    after = name.slice(close + 1);
  } else {
    key = name;
    after = "";
  }
  if (key === "") return undefined;

  if (after === "") {
    if (key === "[]" && depth !== 0) return [v];
    params.set(key, v);
  } else if (after === "[") {
    params.set(name, v);
  } else if (after === "[]") {
    const list = listAt(params, key);
    list.push(v);
  } else if (after.startsWith("[]")) {
    let childKey = after.slice(3, -1);
    const hashInList = after[2] === "[" && after.endsWith("]") && childKey !== "" && !childKey.includes("[") && !childKey.includes("]");
    if (!hashInList) childKey = after.slice(2);
    const list = listAt(params, key);
    const last = list.at(-1);
    if (isHash(last) && !rackHashHasKey(last, childKey)) normalizeParams(last, childKey, v, depth + 1);
    else list.push(normalizeParams(new Map(), childKey, v, depth + 1) as RackValue);
  } else {
    let existing = params.get(key);
    if (existing === undefined || existing === null) {
      existing = new Map();
      params.set(key, existing);
    }
    if (!isHash(existing)) wrongType("Hash");
    params.set(key, normalizeParams(existing, after, v, depth + 1) as RackValue);
  }
  return params;
}

// `params[k] ||= []`, then the Array check.
function listAt(params: RackHash, key: string): RackValue[] {
  let existing = params.get(key);
  if (existing === undefined || existing === null) {
    existing = [];
    params.set(key, existing);
  }
  if (!Array.isArray(existing)) wrongType("Array");
  return existing;
}

export function rackTopLevelParams(query: string): Map<string, RackTopLevelParam> {
  const text = query.replace(/^\?/u, "");
  if (text.length > RACK_BYTESIZE_LIMIT) throw new HandBackToRails("a query string over Rack's size limit");
  const pairs = text.split("&");
  if (pairs.length >= RACK_PARAMS_LIMIT) throw new HandBackToRails("a query string over Rack's pair limit");
  const params: RackHash = new Map();
  for (const pair of pairs) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const name = rackUnescape(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : rackUnescape(pair.slice(index + 1));
    normalizeParams(params, name, value, 0);
  }
  return new Map(
    [...params].map(([key, value]): [string, RackTopLevelParam] => [
      key,
      typeof value === "string" || value === null ? { nested: false, value } : { nested: true },
    ]),
  );
}

// ActionDispatch::Request#referrer
export const referrer = (request: RailsRequest): string | null => request.headers.get("referer");

const BROWSER_LIKE_ACCEPTS = /,\s*\*\/\*|\*\/\*\s*,/u;
const JSON_TYPES = new Set(["application/json", "text/x-json", "application/jsonrequest"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml", "*/*"]);

// request.format.ref for the requests these pages see: html (including the browser-like Accept
// lists, which Rails ignores), json, or "other" for a format the port does not model.
export function requestFormat(request: RailsRequest): "html" | "json" | "other" {
  const accept = request.headers.get("accept");
  const xhr = request.headers.get("x-requested-with") === "XMLHttpRequest";
  const usable =
    (xhr && (isPresent(accept) || request.headers.has("content-type"))) ||
    (isPresent(accept) && !BROWSER_LIKE_ACCEPTS.test(accept));
  if (!usable) return xhr ? "other" : "html";

  const entries = accept!.split(",").map((entry, order) => {
    const [type = "", ...parameters] = entry.trim().split(/\s*;\s*/u);
    const quality = parameters.map((parameter) => /^q=([\d.]+)$/u.exec(parameter)?.[1]).find((q) => q !== undefined);
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
const AUTHORITY_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@[\]]$/u;
const PATH_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/u;
const QUERY_CLASS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/u;

// Addressable::URI.encode_component: every character outside the class, "%" included, becomes its
// UTF-8 bytes as %XX.
const encodeComponent = (value: string, allowed: RegExp) =>
  [...value]
    .map((char) =>
      allowed.test(char) ? char : Buffer.from(char, "utf8").toString("hex").toUpperCase().replace(/../gu, "%$&"),
    )
    .join("");

// RFC 3986 appendix B, which Addressable::URI.parse splits a URI with.
const URI_SPLIT = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/su;

// SafeRedirectPathService#url: URI.parse(Addressable::URI.escape(CGI.unescape(path).split("#").first)).
function escapedUri(path: string) {
  const unescaped = cgiUnescape(path);
  // Ruby's "###".split("#") is empty, and Addressable raises on the nil that leaves.
  if (/^#*$/u.test(unescaped)) throw new HandBackToRails();
  const [, scheme, authority, urlPath = "", query] = URI_SPLIT.exec(unescaped.split("#")[0]!)!;
  // An opaque URI ("javascript:...") has no path, which Ruby's gsub then raises on; any other
  // scheme is Addressable's and URI's to validate.
  if (scheme !== undefined && (authority === undefined || !/^https?$/iu.test(scheme))) throw new HandBackToRails();
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
    const separator = path.search(/[?#]/u);
    const head = separator === -1 ? path : path.slice(0, separator);
    path = head.replaceAll("\\", "/").replace(/%5[Cc]/gu, "/") + (separator === -1 ? "" : path.slice(separator));
  }
  if (!isPresent(path)) return "/";

  const url = escapedUri(path);
  if (url.path === null) throw new HandBackToRails();
  const subdomainHost =
    url.host !== null && new RegExp(`.*\\.${rootDomain.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u").test(url.host);
  if ((allowSubdomainHost && subdomainHost) || url.host === request.host) return path;

  let relative = url.path.replace(/^\/+/u, "/");
  if (relative !== "" && !relative.startsWith("/")) relative = `/${relative}`;
  return url.query === null ? relative : `${relative}?${url.query}`;
}
