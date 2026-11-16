// PiracyReport.parse_http_url, normalize_url and normalized_host (app/models/piracy_report.rb), for the URLs a pattern reads the way
// URI.parse does. Shared by the controllers and the email event job, so it lives apart from both.
import { NotPortedError } from "./user.ts";

const SOURCE = "PiracyReport.parse_http_url";
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };
// A host, port, path, query and fragment URI.parse accepts without a second reading (no userinfo, IPv6, brackets or bare percent signs).
const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const HTTP_URL = new RegExp(
  `^(https?)://([A-Za-z0-9](?:[A-Za-z0-9.-]*))(?::(\\d{1,5}))?((?:/${PCHAR}*)*)(?:\\?((?:${PCHAR}|[/?])*))?(?:#(?:${PCHAR}|[/?])*)?$`,
  "iu",
);

export type Parsed = { scheme: string; host: string; port: number; path: string; query: string | null };

// PiracyReport.parse_http_url, for the URLs HTTP_URL reads the way URI.parse does. A string that is not an http(s) URL under any reading
// answers null; one that starts like one but falls outside the pattern is handed back.
export function parseHttpUrl(value: string): Parsed | null {
  const match = HTTP_URL.exec(value);
  if (match === null) {
    if (/^http/iu.test(value)) throw new NotPortedError("a URL Ruby's URI parser may read differently", SOURCE);
    return null;
  }
  const scheme = match[1]!.toLowerCase();
  return {
    scheme,
    host: match[2]!,
    port: match[3] === undefined ? DEFAULT_PORTS[scheme]! : Number(match[3]),
    path: match[4]!,
    query: match[5] ?? null,
  };
}

// PiracyReport.normalized_host
export const normalizedHost = (host: string): string =>
  host
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");

// PiracyReport.normalize_url: two spellings of the same page collide on the unique index.
export function normalizeUrl(uri: Parsed): string {
  let path = uri.path === "" ? "/" : uri.path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const pairs = (uri.query ?? "").split("&");
  while (pairs.length > 0 && pairs.at(-1) === "") pairs.pop();
  const query = pairs.sort().join("&");
  const port = uri.port === DEFAULT_PORTS[uri.scheme] ? "" : `:${uri.port}`;
  return `${normalizedHost(uri.host)}${port}${path}${query === "" ? "" : `?${query}`}`;
}
