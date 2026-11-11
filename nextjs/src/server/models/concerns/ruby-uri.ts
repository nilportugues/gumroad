// URI.parse(string) as Ruby 3.4's default parser (URI::RFC3986_Parser#split, then URI.for) builds
// it, down to the component checks that can raise. Only what callers read is returned.
import { rubyInspect } from "./ruby-values.ts";

export class RubyUriError extends Error {
  readonly rubyClass: "URI::InvalidURIError" | "URI::InvalidComponentError";
  constructor(rubyClass: RubyUriError["rubyClass"], message: string) {
    super(message);
    this.name = rubyClass;
    this.rubyClass = rubyClass;
  }
}

export const isInvalidUriError = (error: unknown) => error instanceof RubyUriError && error.rubyClass === "URI::InvalidURIError";

// The patterns of rfc3986_parser.rb. Its possessive quantifiers never give back a character the
// next token could take, so plain greedy ones match the same strings.
const H = "[0-9A-Fa-f]";
const DEC_OCTET = String.raw`(?:[1-9]\d|1\d{2}|2[0-4]\d|25[0-5]|\d)`;
const IPV4 = String.raw`${DEC_OCTET}\.${DEC_OCTET}\.${DEC_OCTET}\.${DEC_OCTET}`;
const LS32 = `(?:${H}{1,4}:${H}{1,4}|${IPV4})`;
const IPV6 = [
  `(?:${H}{1,4}:){6}${LS32}`,
  `::(?:${H}{1,4}:){5}${LS32}`,
  // Ruby writes `\h{1,4}?::`, a lazy (not optional) quantifier.
  `${H}{1,4}::(?:${H}{1,4}:){4}${LS32}`,
  `(?:(?:${H}{1,4}:)?${H}{1,4})?::(?:${H}{1,4}:){3}${LS32}`,
  `(?:(?:${H}{1,4}:){0,2}${H}{1,4})?::(?:${H}{1,4}:){2}${LS32}`,
  `(?:(?:${H}{1,4}:){0,3}${H}{1,4})?::${H}{1,4}:${LS32}`,
  `(?:(?:${H}{1,4}:){0,4}${H}{1,4})?::${LS32}`,
  `(?:(?:${H}{1,4}:){0,5}${H}{1,4})?::${H}{1,4}`,
  `(?:(?:${H}{1,4}:){0,6}${H}{1,4})?::`,
].join("|");
const HOST = String.raw`\[(?:${IPV6}|v${H}+\.[!$&-.0-9:;=A-Z_a-z~]+)\]|${IPV4}|(?:%${H}${H}|[!$&-.0-9;=A-Z_a-z~])*`;
const USERINFO = `(?:%${H}${H}|[!$&-.0-9:;=A-Z_a-z~])*`;
const SEG = `(?:%${H}${H}|[!$&-.0-9:;=@A-Z_a-z~/])`;
const SEG_NC = `(?:%${H}${H}|[!$&-.0-9;=@A-Z_a-z~])`;
const FRAGMENT = `(?:%${H}${H}|[!$&-.0-9:;=@A-Z_a-z~/?])*`;
const SCHEME = "[A-Za-z][+\\-.0-9A-Za-z]*";

const RFC3986_URI = new RegExp(
  `^(?<scheme>${SCHEME}):` +
    `(?://(?:(?<userinfo>${USERINFO})@)?(?<host>${HOST})(?::(?<port>\\d*))?(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/(?:(?!/)${SEG}+)?)|(?<rootless>(?!/)${SEG}+)|(?<empty>))` +
    `(?:\\?(?<query>[^#]*))?(?:#(?<fragment>${FRAGMENT}))?$`,
  "u",
);
const RFC3986_RELATIVE_REF = new RegExp(
  `^(?://(?:(?<userinfo>${USERINFO})@)?(?<host>(?:${HOST})(?<!/))?(?::(?<port>\\d*))?(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/${SEG}*)|(?<noscheme>${SEG_NC}+(?:/${SEG}*)?)|(?<empty>))` +
    `(?:\\?(?<query>[^#]*))?(?:#(?<fragment>${FRAGMENT}))?$`,
  "u",
);

export type RubyUri = { scheme: string | null; host: string | null };
// Every component callers read: URI#path (nil for an opaque URI) and URI#query.
export type RubyUriParts = RubyUri & { path: string | null; query: string | null };

function invalid(message: string): never {
  throw new RubyUriError("URI::InvalidURIError", message);
}

// String#dump, as `URI must be ascii only` quotes the string: non-ASCII as \u escapes.
function dump(value: string): string {
  const body = value
    // eslint-disable-next-line no-control-regex
    .split(/([^\x00-\x7f])/u)
    .map((part, i) => {
      if (i % 2 === 0) return rubyInspect(part).slice(1, -1);
      const code = part.codePointAt(0)!;
      return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    })
    .join("");
  return `"${body}"`;
}

export function rubyUriParse(uri: string): RubyUri {
  const { scheme, host } = rubyUriParseParts(uri);
  return { scheme, host };
}

export function rubyUriParseParts(uri: string): RubyUriParts {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/u.test(uri)) invalid(`URI must be ascii only ${dump(uri)}`);
  let scheme: string | null = null;
  let host: string | null = null;
  let path: string | null = null;
  let opaque: string | null = null;
  let query: string | null = null;
  let fragment: string | null = null;
  const absolute = RFC3986_URI.exec(uri);
  if (absolute) {
    const g = absolute.groups!;
    scheme = g.scheme!;
    query = g.query ?? null;
    fragment = g.fragment ?? null;
    if (g.rootless !== undefined) {
      opaque = query === null ? g.rootless : `${g.rootless}?${query}`;
      query = null;
    } else {
      host = g.host ?? null;
      path = g.abempty ?? g.absolute ?? g.empty ?? null;
    }
  } else {
    const relative = RFC3986_RELATIVE_REF.exec(uri);
    if (!relative) invalid(`bad URI (is not URI?): ${rubyInspect(uri)}`);
    const g = relative.groups!;
    host = g.host ?? null;
    path = g.abempty ?? g.absolute ?? g.noscheme ?? g.empty ?? null;
    query = g.query ?? null;
    fragment = g.fragment ?? null;
  }

  // URI.for picks the class by the upcased scheme; Generic for any other.
  const kind = scheme?.toUpperCase() ?? "";
  if (kind === "FTP" && path === null) invalid("URI::InvalidURIError");
  // Generic#query=
  if (query !== null) {
    const bad = /(%[^0-9A-Fa-f][^0-9A-Fa-f])/u.exec(query.replace(/[\t\r\n]/gu, ""));
    if (bad) invalid(`invalid percent escape: ${bad[1]}`);
  }
  if (kind === "FILE" && (host === null || host === "localhost")) host = "";
  if ((kind === "LDAP" || kind === "LDAPS") && (fragment !== null || path === null)) invalid("bad LDAP URL");
  if (kind === "MAILTO") {
    if (query !== null && opaque === null) opaque = `?${query}`;
    if (opaque === null) throw new RubyUriError("URI::InvalidComponentError", "missing opaque part for mailto URL");
    const to = opaque.split("?")[0]!;
    if (!/^(?:[^@,;]+@[^@,;]+(?:$|[,;]))*$/u.test(to)) throw new RubyUriError("URI::InvalidComponentError", `unrecognised opaque part for mailtoURL: ${opaque}`);
  }
  return { scheme: scheme?.toLowerCase() ?? null, host, path, query };
}
