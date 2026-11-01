// Rack's nested query parsing and ActiveSupport's Hash#to_query, as far as the redirects ported so far
// need them: `a[]=1` lists, `a[b]=1` hashes, the last duplicate wins; keys sorted, CGI-escaped.
export type Query = { [key: string]: string | string[] | Query };

export function parseQuery(search: string): Query {
  const result: Query = {};
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const decode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? "" : decode(pair.slice(index + 1));
    const [, base = key, rest = ""] = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(key) ?? [];
    const segments = [...rest.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]!);
    let node: Query = result;
    let name = base;
    for (const [i, segment] of segments.entries()) {
      if (segment === "") {
        const list = Array.isArray(node[name]) ? (node[name] as string[]) : [];
        node[name] = list;
        if (i === segments.length - 1) list.push(value);
        break;
      }
      const child = node[name];
      node = typeof child === "object" && child !== null && !Array.isArray(child) ? child : (node[name] = {});
      name = segment;
    }
    if (segments.length === 0 || segments.at(-1) !== "") node[name] = value;
  }
  return result;
}

// CGI.escape
export const cgiEscape = (value: string) =>
  encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// Hash#to_query: keys sorted, nested as `a[b]=`, lists as `a[]=`.
export function toQuery(query: Query, prefix?: string): string[] {
  return Object.keys(query)
    .sort()
    .flatMap((key) => {
      const value = query[key]!;
      const name = prefix ? `${prefix}[${key}]` : key;
      if (Array.isArray(value)) return value.map((item) => `${cgiEscape(`${name}[]`)}=${cgiEscape(item)}`);
      if (typeof value === "object") return toQuery(value, name);
      return [`${cgiEscape(name)}=${cgiEscape(value)}`];
    });
}
