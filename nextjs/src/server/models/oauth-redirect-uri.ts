// Doorkeeper::OAuth::Helpers::URIChecker.valid_for_authorization? (doorkeeper 5.7.1): the redirect_uri of a code exchange against the
// one stored on the grant. Ruby's URI.parse is the RFC 3986 regexp; what it accepts is mirrored here, and what URI#== compares is the
// normalised component tuple. IP literals follow the RFC 3986 grammar and ws/wss follow URI::WS (no fragment in the tuple). A
// registered ftp, file, ldap(s) or mailto URI, whose class compares other components, is thrown as not ported before anything is
// written; a requested URI of those schemes can only equal a registered one of the same scheme, so with none registered it is refused.
import { NotPortedError } from "./user.ts";

const RUBY_FILE = "doorkeeper-5.7.1/lib/doorkeeper/oauth/helpers/uri_checker.rb";
const OOB_URIS = ["urn:ietf:wg:oauth:2.0:oob", "urn:ietf:wg:oauth:2.0:oob:auto"];
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 };
// URI.scheme_list besides HTTP, HTTPS, WS and WSS: classes with their own parsing or component rules.
const SPECIAL_SCHEMES = new Set(["ftp", "file", "ldap", "ldaps", "mailto"]);
// URI::WS#component has no fragment.
const FRAGMENTLESS_SCHEMES = new Set(["ws", "wss"]);
const IPV6_GROUPS = 8;
const IPV4_OCTETS = 4;
const OCTET_MAX = 255;
const BITS_PER_OCTET = 8;
const LOOPBACK_FIRST_OCTET = 127;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/u;
const DEC_OCTET = /^(?:0|[1-9]\d{0,2})$/u;
const IP_FUTURE = /^v[0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+$/u;
// ::ffff:127.0.0.0/104, shifted past the 24 host bits.
const IPV4_MAPPED_LOOPBACK = 0xffff7fn;
const IPV4_MAPPED_SHIFT = 24n;
const BITS_PER_GROUP = 16n;

const PCT = "%[0-9A-Fa-f]{2}";
const USERINFO = `(?:${PCT}|[!$&-.0-;=A-Z_a-z~])*`;
const REG_NAME = `(?:${PCT}|[!$&-.0-9;=A-Z_a-z~])*`;
const SEGMENT = `(?:${PCT}|[!$&-.0-;=@-Z_a-z~])*`;
const SEGMENT_NZ = `(?:${PCT}|[!$&-.0-;=@-Z_a-z~])+`;
const FRAGMENT = `(?:${PCT}|[!$&-.0-;=@-Z_a-z~/?])*`;
const URI_PATTERN = new RegExp(
  `^([A-Za-z][A-Za-z0-9+\\-.]*):(?:` +
    `//(?:(${USERINFO})@)?(\\[[^\\]]*\\]|${REG_NAME})(?::(\\d*))?((?:/${SEGMENT})*)` +
    `|(/(?:${SEGMENT_NZ}(?:/${SEGMENT})*)?)` +
    `|(${SEGMENT_NZ}(?:/${SEGMENT})*)` +
    `|)` +
    `(?:\\?([^#]*))?(?:#(${FRAGMENT}))?$`,
  "u",
);

type ParsedUri = {
  scheme: string;
  userinfo: string | null;
  host: string | null;
  port: number | null;
  path: string | null;
  opaque: string | null;
  query: string | null;
  fragment: string | null;
  special: boolean;
};

function ipv4Groups(text: string): number[] | null {
  const octets = text.split(".");
  if (octets.length !== IPV4_OCTETS || !octets.every((octet) => DEC_OCTET.test(octet) && Number(octet) <= OCTET_MAX))
    return null;
  return [
    (Number(octets[0]) << BITS_PER_OCTET) | Number(octets[1]),
    (Number(octets[2]) << BITS_PER_OCTET) | Number(octets[3]),
  ];
}

// RFC 3986 IPv6address to its eight groups, or null where the grammar refuses it (Ruby raises URI::InvalidURIError).
function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const side = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        const v4 = last && index === pieces.length - 1 ? ipv4Groups(piece) : null;
        if (v4 === null) return null;
        groups.push(...v4);
      } else if (HEX_GROUP.test(piece)) groups.push(parseInt(piece, 16));
      else return null;
    }
    return groups;
  };
  const head = side(halves[0]!, halves.length === 1);
  if (head === null) return null;
  if (halves.length === 1) return head.length === IPV6_GROUPS ? head : null;
  const tail = side(halves[1]!, true);
  if (tail === null || head.length + tail.length >= IPV6_GROUPS) return null;
  return [...head, ...new Array<number>(IPV6_GROUPS - head.length - tail.length).fill(0), ...tail];
}

const ipv6Loopback = (groups: number[]) => {
  const value = groups.reduce((total, group) => (total << BITS_PER_GROUP) | BigInt(group), 0n);
  return value === 1n || value >> IPV4_MAPPED_SHIFT === IPV4_MAPPED_LOOPBACK;
};

// A zone id (`%25`) is refused by Ruby's RFC 3986 parser, like any other junk between the brackets.
const ipLiteralAccepted = (host: string) => {
  const inner = host.slice(1, -1);
  return ipv6Groups(inner) !== null || IP_FUTURE.test(inner);
};

// URI.parse, or null where Ruby raises URI::InvalidURIError. Ruby's `\z` and a JS `$` differ on a trailing newline, so it is refused.
function parse(url: string): ParsedUri | null {
  if (url.endsWith("\n")) return null;
  const match = URI_PATTERN.exec(url);
  if (match === null) return null;
  const [, scheme, userinfo, host, port, abempty, absolute, rootless, query, fragment] = match;
  if (host?.startsWith("[") && !ipLiteralAccepted(host)) return null;
  const lower = scheme!.toLowerCase();
  const hasAuthority = host !== undefined;
  const portNumber = port === undefined || port === "" ? null : Number(port);
  return {
    scheme: lower,
    userinfo: userinfo ?? null,
    host: hasAuthority ? host : null,
    port: hasAuthority ? (portNumber ?? DEFAULT_PORTS[lower] ?? null) : null,
    path: hasAuthority ? (abempty ?? "") : (absolute ?? null),
    opaque: rootless ?? null,
    query: query ?? null,
    fragment: fragment ?? null,
    special: SPECIAL_SCHEMES.has(lower),
  };
}

const isBlank = (value: string | null) => value === null || /^[\s]*$/u.test(value);

// URIChecker.valid?
function valid(url: string, parsed: ParsedUri | null): boolean {
  if (OOB_URIS.includes(url)) return true;
  if (parsed === null) return false;
  if (parsed.scheme === "localhost") return false;
  const hypertext = parsed.scheme === "http" || parsed.scheme === "https";
  if (hypertext && (parsed.host === null || parsed.host === "")) return false;
  return parsed.fragment === null && parsed.opaque === null;
}

function queryMatches(query: string | null, clientQuery: string | null): boolean {
  if (isBlank(clientQuery) && isBlank(query)) return true;
  if (clientQuery === null || query === null) return false;
  const sorted = (value: string) => JSON.stringify(value.split("&").sort());
  return sorted(clientQuery) === sorted(query);
}

// IPAddr.new(host).loopback?: a dotted quad without zero-filled octets, or a bracketed IPv6 address.
function loopback(host: string | null): boolean {
  if (host === null) return false;
  if (host.startsWith("[")) {
    const groups = ipv6Groups(host.slice(1, -1));
    return groups !== null && ipv6Loopback(groups);
  }
  const groups = ipv4Groups(host);
  return groups !== null && groups[0]! >> BITS_PER_OCTET === LOOPBACK_FIRST_OCTET;
}

function normalised(uri: ParsedUri, withoutQuery: boolean, withoutPort: boolean) {
  const path = uri.path === "" ? "/" : uri.path;
  return JSON.stringify([
    uri.scheme,
    // Generic#port= leaves no userinfo behind, so a loopback comparison ignores it too.
    withoutPort ? null : uri.userinfo,
    uri.host?.toLowerCase() ?? null,
    withoutPort ? null : uri.port,
    path,
    uri.opaque,
    withoutQuery ? null : uri.query,
    FRAGMENTLESS_SCHEMES.has(uri.scheme) ? null : uri.fragment,
  ]);
}

// URIChecker.matches?(url, client_url)
function matches(url: ParsedUri, clientUrl: ParsedUri): boolean {
  let clientQuery = clientUrl.query;
  if (clientQuery !== null) {
    if (!queryMatches(url.query, clientQuery)) return false;
    clientQuery = null;
  }
  // RFC 8252 section 7.3: loopback redirects ignore the port.
  const ignorePort = loopback(url.host) && loopback(clientUrl.host);
  return normalised(url, true, ignorePort) === normalised({ ...clientUrl, query: clientQuery }, true, ignorePort);
}

export function redirectUriAllowed(requested: string, registered: string): boolean {
  const parsed = parse(requested);
  if (!valid(requested, parsed)) return false;
  return registered
    .split(/\s+/u)
    .filter((candidate) => candidate !== "")
    .some((candidate) => {
      const client = parse(candidate);
      if (client === null) throw new NotPortedError("a registered redirect URI Ruby cannot parse", RUBY_FILE);
      if (client.special) throw new NotPortedError(`a registered ${client.scheme} redirect URI`, RUBY_FILE);
      // A requested ftp, file, ldap(s) or mailto URI is another URI class than any candidate left here, which is never ==.
      return !parsed!.special && matches(parsed!, client);
    });
}
