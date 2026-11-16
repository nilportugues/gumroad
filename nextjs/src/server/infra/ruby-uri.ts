// What omniauth-google-oauth2's `image_url` makes of a userinfo `picture` (uri 1.1.1, Ruby 3.4): `URI.parse` (RFC 3986 only, ASCII only), the
// rewrite of the query without `sz`, and `to_s`. Either the string it answers or the exception it raises, with Ruby's own message: that is what
// the failure page shows, so a picture URL Ruby rejects ends the sign-in in the failure action instead of crashing the callback.
//
// Pinned by nextjs/parity/golden/google-image-url.json (Ruby's answers for 1.6k pictures). Modelled per scheme class: HTTP, HTTPS, WS, WSS and
// Generic (an unknown scheme or none) exactly; FTP, FILE, LDAP, LDAPS and MAILTO for the checks their constructors make.
export class RubyUriError extends Error {
  constructor(
    readonly rubyClass: "URI::InvalidURIError" | "URI::InvalidComponentError",
    message: string,
  ) {
    super(message);
  }
}

const HEX = "[0-9a-fA-F]";
const PCT = `%${HEX}{2}`;
const SEG_CHARS = "[!$&-.0-9:;=@A-Z_a-z~/]";
const FRAGMENT_CHARS = "[!$&-.0-9:;=@A-Z_a-z~/?]";
const USERINFO_CHARS = "[!$&-.0-9:;=A-Z_a-z~]";
const REG_NAME_CHARS = "[!$&-.0-9;=A-Z_a-z~]";
const H16 = `${HEX}{1,4}`;
const DEC_OCTET = "(?:[1-9]\\d|1\\d{2}|2[0-4]\\d|25[0-5]|\\d)";
const IPV4 = `(?:${DEC_OCTET}\\.){3}${DEC_OCTET}`;
const LS32 = `(?:${H16}:${H16}|${IPV4})`;
const IPV6 = [
  `(?:${H16}:){6}${LS32}`,
  `::(?:${H16}:){5}${LS32}`,
  `${HEX}{1,4}?::(?:${H16}:){4}${LS32}`,
  `(?:(?:${H16}:)?${H16})?::(?:${H16}:){3}${LS32}`,
  `(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${LS32}`,
  `(?:(?:${H16}:){0,3}${H16})?::${H16}:${LS32}`,
  `(?:(?:${H16}:){0,4}${H16})?::${LS32}`,
  `(?:(?:${H16}:){0,5}${H16})?::${H16}`,
  `(?:(?:${H16}:){0,6}${H16})?::`,
].join("|");
const IP_LITERAL = `\\[(?:${IPV6}|v${HEX}+\\.${USERINFO_CHARS}+)\\]`;
const HOST = `(?:${IP_LITERAL}|${IPV4}|(?:${PCT}|${REG_NAME_CHARS})*)`;
const AUTHORITY = `(?:(?<userinfo>(?:${PCT}|${USERINFO_CHARS})*)@)?(?<host>${HOST})(?::(?<port>\\d*))?`;
const SEG = `(?:${PCT}|${SEG_CHARS})`;
const TAIL = `(?:\\?(?<query>[^#]*))?(?:#(?<fragment>(?:${PCT}|${FRAGMENT_CHARS})*))?$`;

const ABSOLUTE = new RegExp(
  `^(?<scheme>[A-Za-z][+\\-.0-9A-Za-z]*):(?:` +
    `//${AUTHORITY}(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/(?:(?!/)${SEG}+)?)` +
    `|(?<rootless>(?!/)${SEG}+)` +
    `|(?<empty>))${TAIL}`,
  "u",
);
const RELATIVE = new RegExp(
  `^(?:` +
    `//(?:(?<userinfo>(?:${PCT}|${USERINFO_CHARS})*)@)?(?<host>${IP_LITERAL}|${IPV4}|(?:${PCT}|${REG_NAME_CHARS})*(?<!/)|)(?::(?<port>\\d*))?(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/${SEG}*)` +
    `|(?<noscheme>(?:${PCT}|[!$&-.0-9;=@A-Z_a-z~])+(?:/${SEG}*)?)` +
    `|(?<empty>))${TAIL}`,
  "u",
);

// String#inspect for an ASCII string and String#dump for any string.
const NAMED = new Map([
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x1b, "\\e"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);
const hex = (code: number, width: number) => code.toString(16).toUpperCase().padStart(width, "0");

function escapeString(value: string, dump: boolean): string {
  let out = '"';
  const chars = [...value];
  chars.forEach((char, at) => {
    const code = char.codePointAt(0)!;
    const named = NAMED.get(code);
    if (named !== undefined) out += named;
    else if (char === "#" && ["{", "$", "@"].includes(chars[at + 1] ?? "")) out += "\\#";
    else if (code < 0x20 || code === 0x7f) out += dump ? `\\x${hex(code, 2)}` : `\\u${hex(code, 4)}`;
    else if (code < 0x7f) out += char;
    else out += code > 0xffff ? `\\u{${hex(code, 1)}}` : `\\u${hex(code, 4)}`;
  });
  return `${out}"`;
}

type Scheme = "http" | "https" | "ws" | "wss" | "ftp" | "file" | "ldap" | "ldaps" | "mailto" | "generic";
const DEFAULT_PORTS: Partial<Record<Scheme, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
  ldap: 389,
  ldaps: 636,
};
const REGISTERED = new Set<string>(["http", "https", "ws", "wss", "ftp", "file", "ldap", "ldaps", "mailto"]);

type Parts = {
  scheme?: string;
  userinfo?: string;
  host?: string;
  port?: string;
  path?: string;
  opaque?: string;
  query?: string;
  fragment?: string;
};

// URI::RFC3986_Parser#split
function split(input: string): Parts {
  // eslint-disable-next-line no-control-regex -- the ASCII range starts at NUL
  if (/[^\x00-\x7f]/u.test(input))
    throw new RubyUriError("URI::InvalidURIError", `URI must be ascii only ${escapeString(input, true)}`);
  const absolute = ABSOLUTE.exec(input);
  if (absolute?.groups) {
    const g = absolute.groups;
    if (g.rootless !== undefined) {
      return {
        scheme: g.scheme,
        opaque: g.query === undefined ? g.rootless : `${g.rootless}?${g.query}`,
        fragment: g.fragment,
      };
    }
    return {
      scheme: g.scheme,
      userinfo: g.userinfo,
      host: g.host,
      port: g.port,
      path: g.abempty ?? g.absolute ?? g.empty,
      query: g.query,
      fragment: g.fragment,
    };
  }
  const relative = RELATIVE.exec(input);
  if (relative?.groups) {
    const g = relative.groups;
    // Ruby's host group is optional and fails its lookbehind right after `//`; JS cannot skip an empty iteration, so an empty host that no
    // userinfo precedes stands for the group that did not take part.
    return {
      userinfo: g.userinfo,
      host: g.host === "" && g.userinfo === undefined ? undefined : g.host,
      port: g.port,
      path: g.abempty ?? g.absolute ?? g.noscheme ?? g.empty,
      query: g.query,
      fragment: g.fragment,
    };
  }
  throw new RubyUriError("URI::InvalidURIError", `bad URI (is not URI?): ${escapeString(input, false)}`);
}

// Generic#query=: tabs and newlines dropped, a `%` not followed by a hex digit pair refused, and what the query may not hold escaped.
const QUERY_ALLOWED = /^(?:%[0-9a-fA-F]{2}|[!$-&(-;=?-_a-~])/u;
function assignQuery(query: string, hasOpaque: boolean): string {
  if (hasOpaque) throw new RubyUriError("URI::InvalidURIError", "query conflicts with opaque");
  const value = query.replace(/[\t\r\n]/gu, "");
  const bad = /(%[^0-9a-fA-F][^0-9a-fA-F])/u.exec(value);
  if (bad) throw new RubyUriError("URI::InvalidURIError", `invalid percent escape: ${bad[1]}`);
  let out = "";
  for (let at = 0; at < value.length; ) {
    const match = QUERY_ALLOWED.exec(value.slice(at));
    if (match) {
      out += match[0];
      at += match[0].length;
    } else {
      out += `%${hex(value.charCodeAt(at), 2)}`;
      at += 1;
    }
  }
  return out;
}

// Generic#fragment=
function assignFragment(fragment: string): string {
  return fragment
    .replace(/[\t\r\n]/gu, "")
    .replace(/(?!%[0-9a-fA-F]{2})[^!-~]/gu, (char) => `%${hex(char.charCodeAt(0), 2)}`);
}

export type RubyUri = {
  scheme: string | null;
  userinfo: string | null;
  host: string | null;
  port: bigint | null;
  path: string | null;
  opaque: string | null;
  query: string | null;
  fragment: string | null;
  kind: Scheme;
  typecode: string | null;
};

const splitUserinfo = (value: string): [string | null, string | null] => {
  if (value === "") return [null, null];
  const at = value.indexOf(":");
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + 1)];
};

// URI.for + the constructor of the scheme's class.
function build(parts: Parts): RubyUri {
  const lowered = parts.scheme?.toLowerCase();
  const kind: Scheme =
    lowered !== undefined && REGISTERED.has(lowered.replace(/\W/gu, "_")) ? (lowered as Scheme) : "generic";
  let path = parts.path;
  const typecode: string | null = null;
  if (kind === "ftp") {
    if (path === undefined) throw new RubyUriError("URI::InvalidURIError", "URI::InvalidURIError");
    path = path.replace(/^\//u, "").replace(/^%2F/u, "/");
  }
  const uri: RubyUri = {
    scheme: lowered ?? null,
    userinfo: null,
    host: parts.host ?? null,
    port: null,
    path: null,
    opaque: null,
    query: null,
    fragment: null,
    kind,
    typecode,
  };
  if (kind === "file" && (parts.host === undefined || parts.host === "localhost")) uri.host = "";
  if (kind !== "file") {
    if (parts.port !== undefined && parts.port !== "") uri.port = BigInt(parts.port);
    if (parts.userinfo !== undefined) {
      const [user, password] = splitUserinfo(parts.userinfo);
      uri.userinfo = user === null ? null : password === null ? user : `${user}:${password}`;
    }
  }
  uri.path = path === undefined ? null : kind === "ftp" ? `/${path.replace(/^\//u, "%2F")}` : path;
  if (parts.query !== undefined) uri.query = assignQuery(parts.query, false);
  uri.opaque = parts.opaque ?? null;
  if (parts.fragment !== undefined) uri.fragment = assignFragment(parts.fragment);
  if (uri.path === null && uri.opaque === null) uri.path = "";
  const defaultPort = DEFAULT_PORTS[kind];
  if (defaultPort !== undefined && uri.port === null) uri.port = BigInt(defaultPort);

  if (kind === "ftp") {
    const at = uri.path!.indexOf(";type=");
    if (at !== -1) {
      uri.typecode = uri.path!.slice(at + ";type=".length);
      uri.path = uri.path!.slice(0, at);
    }
  }
  if (kind === "ldap" || kind === "ldaps") {
    if (uri.fragment !== null) throw new RubyUriError("URI::InvalidURIError", "bad LDAP URL");
    if (uri.path === null) throw new RubyUriError("URI::InvalidURIError", "bad LDAP URL");
  }
  if (kind === "mailto") {
    if (uri.query !== null && uri.opaque === null) uri.opaque = `?${uri.query}`;
    if (uri.opaque === null) throw new RubyUriError("URI::InvalidComponentError", "missing opaque part for mailto URL");
    const to = uri.opaque.split("?", 2)[0] ?? "";
    if (!/^(?:[^@,;]+@[^@,;]+(?:$|[,;]))*$/u.test(to))
      throw new RubyUriError("URI::InvalidComponentError", `unrecognised opaque part for mailtoURL: ${uri.opaque}`);
  }
  return uri;
}

export function rubyUriParse(input: string): RubyUri {
  return build(split(input));
}

// Generic#query=
export function setQuery(uri: RubyUri, query: string | null): void {
  if (query === null) {
    uri.query = null;
    return;
  }
  uri.query = assignQuery(query, uri.opaque !== null);
}

// Generic#to_s (FTP appends its type code, MAILTO prints its own parts).
export function rubyUriToString(uri: RubyUri): string {
  if (uri.kind === "mailto") {
    const [to, headers] = (uri.opaque ?? "").split(/\?(.*)/su, 2) as [string, string | undefined];
    const pairs =
      headers === undefined
        ? ""
        : `?${headers
            .split("&")
            .map((pair) => pair.split(/=(.*)/su, 2).join("="))
            .join("&")}`;
    return `${uri.scheme}:${to}${pairs}${uri.fragment === null ? "" : `#${uri.fragment}`}`;
  }
  let out = uri.scheme === null ? "" : `${uri.scheme}:`;
  if (uri.opaque !== null) out += uri.opaque;
  else {
    const path = uri.typecode === null ? uri.path! : `${uri.path}${";type="}${uri.typecode}`;
    if (uri.host !== null || uri.scheme === "file") out += "//";
    if (uri.userinfo !== null) out += `${uri.userinfo}@`;
    if (uri.host !== null) out += uri.host;
    const defaultPort = DEFAULT_PORTS[uri.kind];
    if (uri.port !== null && (defaultPort === undefined || uri.port !== BigInt(defaultPort))) out += `:${uri.port}`;
    if ((uri.host !== null || uri.port !== null) && path !== "" && !path.startsWith("/")) out += "/";
    out += path;
    if (uri.query !== null) out += `?${uri.query}`;
  }
  if (uri.fragment !== null) out += `#${uri.fragment}`;
  return out;
}
