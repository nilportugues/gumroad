import { queryParam } from "./rails-request.ts";
import type { RailsRequest } from "./rails-request.ts";

// ActionDispatch::Http::MimeNegotiation#formats and Mime::Type.parse (actionpack 8.1), as far as
// ActionDispatch::PublicExceptions reads them: the first format a request asks for. The Accept
// header is not "the first entry": a header with a comma is sorted by q, then position, and one
// without a comma is read whole.
export type MimeType = { string: string; symbol: string | null; synonyms: string[] };

// Mime::SET (config/initializers/mime_types.rb adds nothing), in registration order.
const REGISTERED: [string, string, string[]][] = [
  ["text/html", "html", ["application/xhtml+xml"]],
  ["text/plain", "text", []],
  ["text/javascript", "js", ["application/javascript", "application/x-javascript"]],
  ["text/css", "css", []],
  ["text/calendar", "ics", []],
  ["text/csv", "csv", []],
  ["text/vcard", "vcf", []],
  ["text/vtt", "vtt", ["vtt"]],
  ["text/markdown", "md", []],
  ["image/png", "png", []],
  ["image/jpeg", "jpeg", []],
  ["image/gif", "gif", []],
  ["image/bmp", "bmp", []],
  ["image/tiff", "tiff", []],
  ["image/svg+xml", "svg", []],
  ["image/webp", "webp", []],
  ["video/mpeg", "mpeg", []],
  ["audio/mpeg", "mp3", []],
  ["audio/ogg", "ogg", []],
  ["audio/aac", "m4a", ["audio/mp4"]],
  ["video/webm", "webm", []],
  ["video/mp4", "mp4", []],
  ["font/otf", "otf", []],
  ["font/ttf", "ttf", []],
  ["font/woff", "woff", []],
  ["font/woff2", "woff2", []],
  ["application/xml", "xml", ["text/xml", "application/x-xml"]],
  ["application/rss+xml", "rss", []],
  ["application/atom+xml", "atom", []],
  ["application/x-yaml", "yaml", ["text/yaml"]],
  ["multipart/form-data", "multipart_form", []],
  ["application/x-www-form-urlencoded", "url_encoded_form", []],
  ["application/json", "json", ["text/x-json", "application/jsonrequest", "application/problem+json"]],
  ["application/pdf", "pdf", []],
  ["application/zip", "zip", []],
  ["application/gzip", "gzip", ["application/x-gzip"]],
  ["application/smil+xml", "smil", []],
  ["application/x-mpegurl", "m3u8", []],
];
const MIME_SET: MimeType[] = REGISTERED.map(([string, symbol, synonyms]) => ({ string, symbol, synonyms }));

// Mime::LOOKUP: a type by its string or any synonym.
const LOOKUP = new Map<string, MimeType>();
for (const type of MIME_SET)
  for (const key of [type.string, ...type.synonyms]) if (!LOOKUP.has(key)) LOOKUP.set(key, type);

// Mime::EXTENSION_LOOKUP: the symbol plus each registered extension synonym.
const EXTENSION_SYNONYMS: Record<string, string> = {
  xhtml: "html",
  txt: "text",
  markdown: "md",
  jpg: "jpeg",
  jpe: "jpeg",
  pjpeg: "jpeg",
  tif: "tiff",
  mpg: "mpeg",
  mpe: "mpeg",
  mp1: "mp3",
  mp2: "mp3",
  oga: "ogg",
  spx: "ogg",
  opus: "ogg",
  mpg4: "m4a",
  aac: "m4a",
  m4v: "mp4",
  yml: "yaml",
  gz: "gzip",
};
const EXTENSION_LOOKUP = new Map<string, MimeType>();
for (const type of MIME_SET)
  if (type.symbol && !EXTENSION_LOOKUP.has(type.symbol)) EXTENSION_LOOKUP.set(type.symbol, type);
for (const [extension, symbol] of Object.entries(EXTENSION_SYNONYMS))
  EXTENSION_LOOKUP.set(extension, EXTENSION_LOOKUP.get(symbol)!);

// Mime::Type#initialize rejects a string that is not `type/subtype` (or `*/*`); the parameters were
// cut off before it gets here.
const MIME_NAME = "[a-zA-Z0-9][a-zA-Z0-9!#$&\\-^_.+]{0,126}";
const MIME_REGEXP = new RegExp(`^(?:\\*/\\*|${MIME_NAME}/(?:\\*|${MIME_NAME})\\s*)$`, "u");
const TRAILING_STAR = /^(text|application)\/\*/mu;
const PARAMETER_SEPARATOR = /;\s*q="?/u;
const ACCEPT_HEADER = /[^,\s"](?:[^,"]|"[^"]*")*/gu;

// Mime::Type::InvalidMimeType: Rails answers every request that carries one with an empty 406,
// whatever the route.
export class InvalidMimeType extends Error {}

function lookup(string: string): MimeType {
  const known = LOOKUP.get(string);
  if (known) return known;
  const stripped = (string.split(";", 2)[0] ?? "").trimEnd();
  const stripped_known = LOOKUP.get(stripped);
  if (stripped_known) return stripped_known;
  if (!MIME_REGEXP.test(stripped)) throw new InvalidMimeType(`${JSON.stringify(stripped)} is not a valid MIME type`);
  return { string: stripped, symbol: null, synonyms: [] };
}

// Mime::Type#match?: an unanchored substring test against the string and its synonyms.
const matchesStar = (type: MimeType, prefix: string) =>
  [...type.synonyms, type.string].some((candidate) => candidate.includes(prefix));
const expandStar = (header: string): MimeType[] | null => {
  const prefix = TRAILING_STAR.exec(header)?.[1];
  return prefix === undefined ? null : MIME_SET.filter((type) => matchesStar(type, prefix));
};

// String#to_f: the leading number, 0.0 when there is none.
function rubyToF(value: string): number {
  const match = /^\s*[+-]?(?:\d[\d_]*)?(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(value)?.[0] ?? "";
  const number = Number.parseFloat(match.replaceAll("_", ""));
  return Number.isNaN(number) ? 0 : number;
}

type AcceptItem = { index: number; name: string; q: number };

// Mime::Type.parse
export function parseAccept(header: string): MimeType[] {
  if (!header.includes(",")) {
    const separator = header.search(PARAMETER_SEPARATOR);
    const whole = (separator === -1 ? header : header.slice(0, separator)).trim();
    if (whole === "") return [];
    return expandStar(whole) ?? [lookup(whole)];
  }
  const list: AcceptItem[] = [];
  let index = 0;
  for (const token of header.match(ACCEPT_HEADER) ?? []) {
    const parts = token.split(PARAMETER_SEPARATOR);
    const name = (parts[0] ?? "").trim();
    // Ruby's split drops a trailing empty field, so "a;q=" has no q.
    const given = parts.length === 2 && parts[1] === "" ? undefined : parts[1];
    if (name === "") continue;
    const quality = given === undefined ? (name === "*/*" ? 0 : 1) : rubyToF(given);
    for (const type of expandStar(name) ?? [{ string: name, symbol: null, synonyms: [] }]) {
      list.push({ index, name: type.string, q: Math.trunc(quality * 100) });
      index += 1;
    }
  }
  return sortAcceptList(list);
}

// Mime::AcceptList.sort!
function sortAcceptList(list: AcceptItem[]): MimeType[] {
  list.sort((a, b) => b.q - a.q || a.index - b.index);
  const byName = (name: string) => {
    const found = list.findIndex((item) => item.name === name);
    return found === -1 ? null : found;
  };
  const textXml = byName("text/xml");
  let appXml = byName("application/xml");
  if (textXml !== null && appXml !== null) {
    let textIndex = textXml;
    const app = list[appXml]!;
    const text = list[textXml]!;
    app.q = Math.max(text.q, app.q);
    if (appXml > textIndex) {
      list[appXml] = text;
      list[textIndex] = app;
      [appXml, textIndex] = [textIndex, appXml];
    }
    list.splice(textIndex, 1);
  } else if (textXml !== null) {
    list[textXml]!.name = "application/xml";
  }
  // More specific XML-based types sort ahead of application/xml.
  if (appXml !== null) {
    const app = list[appXml]!;
    let at = appXml;
    while (at < list.length) {
      const item = list[at]!;
      if (item.q < app.q) break;
      if (item.name.endsWith("+xml")) {
        list[appXml] = item;
        list[at] = app;
        appXml = at;
      }
      at += 1;
    }
  }
  const seen = new Set<string>();
  const types: MimeType[] = [];
  for (const item of list) {
    const type = lookup(item.name);
    const key = `${type.string}\0${type.symbol}`;
    if (!seen.has(key)) {
      seen.add(key);
      types.push(type);
    }
  }
  return types;
}

const isBlank = (value: string | null | undefined) => value === null || value === undefined || value.trim() === "";

// `request.formats`: a `format` parameter first, then the Accept header when it is usable, then XHR's
// JavaScript, then HTML. Only the formats a type is registered for survive.
// The path's extension stands for the route's `(.:format)` segment, which every route has unless it says
// `format: false`; a route's `defaults: { format: ... }` is not known here.
export function requestFormats(request: RailsRequest): MimeType[] {
  const extension = /\.(\w+)$/u.exec(request.path)?.[1];
  const queryFormat = queryParam(request, "format");
  const formatParam = extension ?? queryFormat;
  let formats: MimeType[];
  if (formatParam !== undefined && formatParam !== null) {
    const type = EXTENSION_LOOKUP.get(formatParam);
    formats = type ? [type] : [];
  } else {
    const accept = request.headers.get("accept");
    const xhr = /XMLHttpRequest/iu.test(request.headers.get("x-requested-with") ?? "");
    const contentType = request.headers.has("content-type")
      ? contentMimeType(request.headers.get("content-type")!)
      : null;
    const usable =
      (xhr && (!isBlank(accept) || contentType !== null)) ||
      (!isBlank(accept) && !/,\s*\*\/\*|\*\/\*\s*,/u.test(accept!));
    if (usable) {
      formats = isBlank(accept) ? [contentType!] : parseAccept(accept!.trim());
    } else {
      formats = xhr ? [EXTENSION_LOOKUP.get("js")!] : [EXTENSION_LOOKUP.get("html")!];
    }
  }
  return formats.filter((type) => type.symbol !== null || type.string === "*/*");
}

// `content_mime_type`: the Content-Type up to the first comma or semicolon.
function contentMimeType(header: string): MimeType | null {
  const match = /^([^,;]*)/u.exec(header);
  return match ? lookup(match[1]!.trim().toLowerCase()) : null;
}
