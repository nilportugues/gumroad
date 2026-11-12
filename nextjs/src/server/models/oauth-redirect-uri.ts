// Doorkeeper::OAuth::Helpers::URIChecker.valid_for_authorization? (doorkeeper 5.7.1): the redirect_uri of a code exchange against the
// one stored on the grant. Ruby's URI.parse is the RFC 3986 regexp; what it accepts is mirrored here, and what URI#== compares is the
// normalised component tuple. Shapes whose Ruby class or grammar this does not model (IP literals, the schemes with their own URI
// class) are thrown as not ported before anything is written.
import { NotPortedError } from "./user.ts";

const RUBY_FILE = "doorkeeper-5.7.1/lib/doorkeeper/oauth/helpers/uri_checker.rb";
const OOB_URIS = ["urn:ietf:wg:oauth:2.0:oob", "urn:ietf:wg:oauth:2.0:oob:auto"];
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };
// URI.scheme_list besides HTTP and HTTPS: classes with their own parsing or component rules.
const SPECIAL_SCHEMES = new Set(["ftp", "file", "ldap", "ldaps", "mailto", "ws", "wss"]);

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
};

// URI.parse, or null where Ruby raises URI::InvalidURIError. Ruby's `\z` and a JS `$` differ on a trailing newline, so it is refused.
function parse(url: string): ParsedUri | null {
  if (url.endsWith("\n")) return null;
  const match = URI_PATTERN.exec(url);
  if (match === null) return null;
  const [, scheme, userinfo, host, port, abempty, absolute, rootless, query, fragment] = match;
  if (host?.startsWith("[")) throw new NotPortedError("a redirect URI with an IP literal host", RUBY_FILE);
  const lower = scheme!.toLowerCase();
  if (SPECIAL_SCHEMES.has(lower)) throw new NotPortedError(`a ${lower} redirect URI`, RUBY_FILE);
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

// IPAddr.new(host).loopback? for the dotted-quad IPv4 hosts (IP literals were refused above).
function loopback(host: string | null): boolean {
  const match = host === null ? null : /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255) && Number(match[1]) === 127;
}

function normalised(uri: ParsedUri, withoutQuery: boolean, withoutPort: boolean) {
  const path = uri.path === "" ? "/" : uri.path;
  return JSON.stringify([
    uri.scheme,
    uri.userinfo,
    uri.host?.toLowerCase() ?? null,
    withoutPort ? null : uri.port,
    path,
    uri.opaque,
    withoutQuery ? null : uri.query,
    uri.fragment,
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
      return matches(parsed!, client);
    });
}
