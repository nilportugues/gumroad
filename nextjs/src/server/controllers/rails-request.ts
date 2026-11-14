// The parts of ActionDispatch::Request that controller ports read: host, scheme, query params
// and cookies, as Rails derives them from the incoming request.
import { requestCookies } from "./rack-cookies.ts";

export type RailsRequest = {
  method: string;
  // request.path and request.query_string (raw, without "?").
  path: string;
  queryString: string;
  headers: Headers;
  // request.host (no port) and request.host_with_port.
  host: string;
  hostWithPort: string;
  // request.protocol: "https://" or "http://".
  protocol: string;
  cookies: Map<string, string | null>;
};

const STANDARD_PORTS: Record<string, string> = { "http://": "80", "https://": "443" };

export function railsRequest(request: Request): RailsRequest {
  const url = new URL(request.url);
  // raw_host_with_port: the last X-Forwarded-Host entry wins over Host.
  const forwarded = request.headers.get("x-forwarded-host");
  const rawHost = (forwarded ? forwarded.split(/,\s?/u).at(-1) : request.headers.get("host")) ?? url.host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(/,\s?/u)[0];
  const protocol = `${forwardedProto ?? url.protocol.replace(":", "")}://` === "https://" ? "https://" : "http://";
  const host = rawHost.replace(/:\d+$/u, "");
  const port = /:(\d+)$/u.exec(rawHost)?.[1];
  return {
    method: request.method,
    path: url.pathname,
    queryString: url.search.replace(/^\?/u, ""),
    headers: request.headers,
    host,
    hostWithPort: port && port !== STANDARD_PORTS[protocol] ? `${host}:${port}` : host,
    protocol,
    cookies: requestCookies(request.headers.get("cookie")),
  };
}

// Rack::Request#fullpath.
export function fullpath(request: RailsRequest): string {
  return request.queryString === "" ? request.path : `${request.path}?${request.queryString}`;
}

// params[name] for a flat (non-bracketed) query key, as Rack's nested query parser reads it: the
// last occurrence wins and a key without "=" is nil. Undefined when the key is absent.
export function queryParam(request: RailsRequest, name: string): string | null | undefined {
  let value: string | null | undefined;
  for (const pair of request.queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    if (key === name) value = index === -1 ? null : decode(pair.slice(index + 1));
  }
  return value;
}

// `Array(params[name]).select { _1.is_a?(String) }`: a flat key gives its last value, `name[]` keys give each value in order.
// Null for a flat key mixed with `name[]` (a Rack ParameterTypeError) or `name[key]` (a hash), which the port does not answer.
export function queryParamStrings(request: RailsRequest, name: string): string[] | null {
  let flat: string | null | undefined;
  const list: (string | null)[] = [];
  for (const pair of request.queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : decode(pair.slice(index + 1));
    if (key === name) flat = value;
    else if (key === `${name}[]`) list.push(value);
    else if (key.startsWith(`${name}[`)) return null;
  }
  if (flat !== undefined && list.length > 0) return null;
  return (flat === undefined ? list : [flat]).filter((value): value is string => value !== null);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

// ActiveSupport's String#present?.
export function isPresent(value: string | null | undefined): value is string {
  return value != null && /[^\s]/u.test(value);
}
