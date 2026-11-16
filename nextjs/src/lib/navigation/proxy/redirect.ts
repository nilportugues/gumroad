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

type QueryNode = string | null | string[] | Map<string, QueryNode>;

// A key Rack nests: `a`, `a[b]`, `a[b][c]`, a trailing `[]` makes a list. Anything else (a list of hashes, an unclosed or
// leading bracket) is a shape Rack reads by other rules, so the request stays with Rails.
const NESTED_KEY = /^([^[\]]+)((?:\[[^[\]]+\])*)(\[\])?$/u;
const MAX_DEPTH = 8;

// Hash#to_query on a hash or list: a hash sorts its already-joined children, so `a[b]=1&a[c]=2` sorts as one chunk.
function nodeToQuery(node: QueryNode, name: string): string | null {
  if (node === null) return null;
  if (typeof node === "string") return `${encodeBytes(name, QUERY_SAFE, "+")}=${encodeBytes(node, QUERY_SAFE, "+")}`;
  if (Array.isArray(node)) return node.map((item) => nodeToQuery(item, `${name}[]`)).join("&");
  return [...node]
    .map(([key, child]) => nodeToQuery(child, name === "" ? key : `${name}[${key}]`))
    .filter((chunk): chunk is string => chunk !== null)
    .sort()
    .join("&");
}

// `request.query_parameters.to_query`: null when Rails has to answer (a nesting conflict is its 400).
function toQuery(search: string): string | null {
  const root = new Map<string, QueryNode>();
  for (const pair of search.replace(/^\?/u, "").split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const key = decode(rawKey.replace(/\+/gu, " "));
    if (key === "") return null;
    const match = NESTED_KEY.exec(key);
    if (match === null) return null;
    const path = [match[1]!, ...[...match[2]!.matchAll(/\[([^[\]]+)\]/gu)].map((segment) => segment[1]!)];
    const isList = match[3] !== undefined;
    if (path.length > MAX_DEPTH) return null;
    // A key with no `=` parses to nil, which to_query leaves out; a later pair for the same key wins.
    if (separator === -1 && (isList || path.length > 1)) return null;
    const value = separator === -1 ? null : decode(pair.slice(separator + 1).replace(/\+/gu, " "));
    let node = root;
    for (const segment of path.slice(0, -1)) {
      const child = node.get(segment) ?? (node.set(segment, new Map()).get(segment) as QueryNode);
      if (!(child instanceof Map)) return null;
      node = child;
    }
    const leaf = path.at(-1)!;
    const existing = node.get(leaf);
    if (isList) {
      if (existing === undefined) node.set(leaf, [value as string]);
      else if (Array.isArray(existing)) existing.push(value as string);
      else return null;
    } else if (existing !== undefined && typeof existing !== "string" && existing !== null) return null;
    else node.set(leaf, value);
  }
  return nodeToQuery(root, "");
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
