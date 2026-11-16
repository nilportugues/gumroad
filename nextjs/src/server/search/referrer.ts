// lib/utilities/referrer.rb's Referrer.extract_domain, over Ruby 3.4's URI (uri 1.1.1):
// RFC3986_Parser#unescape, then `encode!("UTF-8", "binary", invalid/undef: replace "")` (which drops
// every byte >= 0x80, valid UTF-8 or not), whitespace removed, URI.parse(url).host.
export const DEFAULT_VALUE = "direct";

// URI::RFC3986_Parser::RFC3986_URI and RFC3986_relative_ref with their \g<> calls expanded.
// Ruby's possessive quantifiers become greedy ones: none of them is followed by a character its
// own class can match, so backtracking into them never finds another match.
const DEC_OCTET = "(?:[1-9]\\d|1\\d{2}|2[0-4]\\d|25[0-5]|\\d)";
const IPV4 = `(?:${DEC_OCTET}\\.${DEC_OCTET}\\.${DEC_OCTET}\\.${DEC_OCTET})`;
const H = "[0-9A-Fa-f]";
const LS32 = `(?:${H}{1,4}:${H}{1,4}|${IPV4})`;
const IPV6 = [
  `(?:${H}{1,4}:){6}${LS32}`,
  `::(?:${H}{1,4}:){5}${LS32}`,
  `${H}{1,4}?::(?:${H}{1,4}:){4}${LS32}`,
  `(?:(?:${H}{1,4}:)?${H}{1,4})?::(?:${H}{1,4}:){3}${LS32}`,
  `(?:(?:${H}{1,4}:){0,2}${H}{1,4})?::(?:${H}{1,4}:){2}${LS32}`,
  `(?:(?:${H}{1,4}:){0,3}${H}{1,4})?::${H}{1,4}:${LS32}`,
  `(?:(?:${H}{1,4}:){0,4}${H}{1,4})?::${LS32}`,
  `(?:(?:${H}{1,4}:){0,5}${H}{1,4})?::${H}{1,4}`,
  `(?:(?:${H}{1,4}:){0,6}${H}{1,4})?::`,
].join("|");
const IP_FUTURE = `v${H}+\\.[!$&-.0-9:;=A-Z_a-z~]+`;
const HOST = `(?:\\[(?:${IPV6}|${IP_FUTURE})\\]|${IPV4}|(?:%${H}${H}|[!$&-.0-9;=A-Z_a-z~])*)`;
const USERINFO = `(?:%${H}${H}|[!$&-.0-9:;=A-Z_a-z~])*`;
const SCHEME = "[A-Za-z][+\\-.0-9A-Za-z]*";
const SEG = `(?:%${H}${H}|[!$&-.0-9:;=@A-Z_a-z~/])`;
const SEG_NC = `(?:%${H}${H}|[!$&-.0-9;=@A-Z_a-z~])`;
const FRAGMENT = `(?:%${H}${H}|[!$&-.0-9:;=@A-Z_a-z~/?])*`;

const RFC3986_URI = new RegExp(
  `^(?<scheme>${SCHEME}):(?:\\/\\/(?:(?:${USERINFO})@)?(?<host>${HOST})(?::\\d*)?(?<abempty>(?:\\/${SEG}*)?)|(?<absolute>\\/(?:(?!\\/)${SEG}+)?)|(?<rootless>(?!\\/)${SEG}+)|(?<empty>))(?:\\?(?<query>[^#]*))?(?:#${FRAGMENT})?$`,
  "u",
);
const RFC3986_RELATIVE_REF = new RegExp(
  `^(?:\\/\\/(?:(?:${USERINFO})@)?(?<host>${HOST}(?<!\\/))?(?::\\d*)?(?:\\/${SEG}*)?|\\/${SEG}*|${SEG_NC}+(?:\\/${SEG}*)?|)(?:\\?[^#]*)?(?:#${FRAGMENT})?$`,
  "u",
);

class InvalidUriError extends Error {}
// URI::InvalidComponentError is not rescued by extract_domain, so it fails the caller.
export class UriInvalidComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "URI::InvalidComponentError";
  }
}

const FTP_TYPECODES = new Set(["a", "i", "d"]);

// URI.parse(url).host, including the scheme classes' constructor checks that can raise.
function parseHost(url: string): string | null {
  const m = RFC3986_URI.exec(url);
  if (m) {
    const groups = m.groups!;
    const scheme = groups.scheme!.toUpperCase();
    const opaque = groups.rootless;
    if (scheme === "MAILTO" && opaque === undefined) throw new UriInvalidComponentError("missing opaque part for mailto URL");
    if (opaque !== undefined) {
      // FTP and LDAP need a path; with an opaque part there is none.
      if (scheme === "FTP" || scheme === "LDAP" || scheme === "LDAPS") throw new InvalidUriError();
      return null;
    }
    const path = groups.abempty ?? groups.absolute ?? groups.empty ?? "";
    if (scheme === "FTP") {
      const at = path.indexOf(";type=");
      if (at >= 0 && !FTP_TYPECODES.has(path.slice(at + 6))) throw new UriInvalidComponentError(`bad typecode(expected a, i, d): ${path.slice(at + 6)}`);
    }
    if ((scheme === "LDAP" || scheme === "LDAPS") && groups.query !== undefined && groups.query.split("?").length > 4) throw new InvalidUriError();
    return groups.host ?? null;
  }
  const relative = RFC3986_RELATIVE_REF.exec(url);
  if (relative) return relative.groups!.host ?? null;
  throw new InvalidUriError();
}

// RFC3986_Parser#unescape on a binary string, then the binary→UTF-8 transcode that drops every
// non-ASCII byte.
function unescapeToAscii(url: string): string {
  const bytes: number[] = [];
  const input = Buffer.from(url, "utf8");
  for (let i = 0; i < input.length; i++) {
    const hex = input.subarray(i + 1, i + 3).toString("latin1");
    if (input[i] === 0x25 && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(input[i]!);
    }
  }
  return String.fromCharCode(...bytes.filter((b) => b < 0x80));
}

const isBlankString = (value: string) => /^\s*$/u.test(value);

export function extractDomain(url: string | null | undefined): string {
  if (url === null || url === undefined || isBlankString(url) || url === "direct") return DEFAULT_VALUE;
  let domain: string | null = null;
  try {
    const cleaned = unescapeToAscii(url).replace(/[ \t\r\n\f\v]+/gu, "");
    const host = parseHost(cleaned)?.toLowerCase() ?? null;
    if (host === null || isBlankString(host)) return DEFAULT_VALUE;
    domain = host.startsWith("www.") ? host.slice(4) : host;
  } catch (error) {
    if (!(error instanceof InvalidUriError)) throw error;
  }
  return domain === null || isBlankString(domain) ? DEFAULT_VALUE : domain;
}
