// The target of a router-level redirect (routes.rb `redirect`), as ActionDispatch::Routing::Redirect builds it.
import type { CompiledRoute } from "./route-table";

// Journey::Router::Utils.escape_path: what `redirect("/l/%{id}")` writes a decoded path parameter back as.
const PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/u;
// CGI.escape, which Hash#to_query keys and values go through.
const QUERY_SAFE = /[A-Za-z0-9_.\-~]/u;

const encodeBytes = (value: string, safe: RegExp, space = "%20") =>
  Array.from(value)
    .map((char) =>
      safe.test(char)
        ? char
        : char === " "
          ? space
          : Array.from(
              new TextEncoder().encode(char),
              (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
            ).join(""),
    )
    .join("");

const decode = (value: string) => decodeURIComponent(value);

function pathParams(route: CompiledRoute, pathname: string): Record<string, string> {
  const params: Record<string, string> = {};
  const patternSegments = route.path.split("/");
  const segments = pathname.split("/");
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(":")) params[/^:(\w+)/u.exec(segment)![1]!] = decode(segments[index] ?? "");
  });
  return params;
}

// `request.query_parameters.to_query` for a query of plain `key=value` pairs. Brackets make Rack nest the parameters, which
// is not ported, so such a query returns null and the request stays with Rails.
function toQuery(search: string): string | null {
  const values = new Map<string, string | null>();
  for (const pair of search.replace(/^\?/u, "").split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const key = decode(rawKey.replace(/\+/gu, " "));
    if (key === "" || /[[\]]/u.test(key)) return null;
    // A key with no `=` parses to nil, which to_query leaves out; a later pair for the same key wins.
    values.set(key, separator === -1 ? null : decode(pair.slice(separator + 1).replace(/\+/gu, " ")));
  }
  return [...values]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${encodeBytes(key, QUERY_SAFE, "+")}=${encodeBytes(value, QUERY_SAFE, "+")}`)
    .sort()
    .join("&");
}

// The Location path for a request the route matched, or null when Rails has to answer it.
export function redirectLocation(route: CompiledRoute, url: URL): string | null {
  try {
    if (route.redirectReplace !== null) {
      const [from, to] = route.redirectReplace;
      return `${url.pathname}${url.search}`.replace(from, () => to);
    }
    const params = pathParams(route, url.pathname);
    if (Object.entries(route.redirectExcept).some(([name, values]) => values.includes(params[name] ?? ""))) return null;
    const path = route.redirect!.replace(/%\{(\w+)\}/gu, (_match, name: string) =>
      encodeBytes(params[name] ?? "", PATH_SAFE),
    );
    if (route.redirectQuery === "keep") return `${path}${url.search}`;
    if (route.redirectQuery === "to_query") {
      const query = toQuery(url.search);
      if (query === null) return null;
      return query === "" ? path : `${path}?${query}`;
    }
    return path;
  } catch {
    // Malformed percent-encoding: Rails answers it (a 400), not the redirect.
    return null;
  }
}
