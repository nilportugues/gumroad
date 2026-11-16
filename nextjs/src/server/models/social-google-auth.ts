// The auth hash omniauth-google-oauth2 1.1.2 builds from the userinfo answer (`uid`, `info`, `extra`), and the reads
// User::SocialGoogle makes of it (app/models/concerns/user/social_google.rb). Nothing here writes; social-google.ts consumes it.
import { rubyUriParse, rubyUriToString, RubyUriError, setQuery } from "../infra/ruby-uri.ts";

type Hash = Record<string, unknown>;
const isHash = (value: unknown): value is Hash => value !== null && typeof value === "object" && !Array.isArray(value);

export const DELETED_ACCOUNT_EMAIL_DOMAIN = "deleted.invalid";

export type GoogleAuthData = {
  uid: string | null;
  info: { name?: string; email?: string; unverified_email?: string; email_verified?: unknown; image?: string };
  // The pruned userinfo answer; a String answer is kept as it came.
  rawInfo: Hash | string;
};

// The gem's `prune!`: nil and empty values (strings, arrays, hashes) are dropped, depth first. `false` and 0 stay.
export function prune(value: Hash): Hash {
  const out: Hash = {};
  for (const [key, item] of Object.entries(value)) {
    const inner = isHash(item) ? prune(item) : item;
    const empty =
      inner === null ||
      inner === undefined ||
      (typeof inner === "string" && inner === "") ||
      (Array.isArray(inner) && inner.length === 0) ||
      (isHash(inner) && Object.keys(inner).length === 0);
    if (!empty) out[key] = inner;
  }
  return out;
}

const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;

// An exception raised while OmniAuth builds the auth hash. The strategy ends in `fail!(e.message, e)`, so the message is the failure kind the
// failure action shows.
export class AuthHashError extends Error {}

// The bytes of an ASCII string as Ruby's binary strings hold them: one character per byte.
const BYTE_SAFE = /[*\-.0-9A-Z_a-z]/u;
const hexByte = (code: number) => `%${code.toString(16).toUpperCase().padStart(2, "0")}`;

// URI.encode_www_form_component on bytes: space is "+", and "*-._" and alphanumerics stay.
function formEncode(bytes: string): string {
  let out = "";
  for (const char of bytes) out += BYTE_SAFE.test(char) ? char : char === " " ? "+" : hexByte(char.charCodeAt(0));
  return out;
}

// CGI.unescape on bytes: "+" is a space and every %hh is a byte; anything else stays.
const formDecode = (text: string) =>
  text
    .replaceAll("+", " ")
    .replace(/%([0-9a-fA-F]{2})/gu, (_, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)));

// CGI.parse, `params.delete_if { |key| key == 'sz' }`, then URI.encode_www_form; nil when nothing is left.
function stripSize(query: string): string | null {
  const grouped = new Map<string, string[]>();
  for (const pair of query.split(/[&;]/u)) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = formDecode(at === -1 ? pair : pair.slice(0, at));
    const entries = grouped.get(key) ?? [];
    if (at !== -1) entries.push(formDecode(pair.slice(at + 1)));
    grouped.set(key, entries);
  }
  grouped.delete("sz");
  if (grouped.size === 0) return null;
  // A key with no "=" is an empty list, which encode_www_form writes as an empty segment.
  return [...grouped]
    .map(([key, entries]) => entries.map((entry) => `${formEncode(key)}=${formEncode(entry)}`).join("&"))
    .join("&");
}

// The receiver NoMethodError#message names, in Ruby 3.4's wording.
function receiverName(value: unknown): string {
  if (value === true) return "true";
  if (Array.isArray(value)) return "an instance of Array";
  if (typeof value === "object") return "an instance of Hash";
  return Number.isInteger(value) || typeof value === "bigint" ? "an instance of Integer" : "an instance of Float";
}

// `image_url`: the picture with a doubled scheme repaired, parsed as Ruby's URI does, and the query rewritten without `sz`. An address
// URI.parse rejects raises (AuthHashError), as in Rails.
export function googleImageUrl(picture: unknown): string | null {
  if (!truthy(picture)) return null;
  if (typeof picture !== "string") throw new AuthHashError(`undefined method 'gsub' for ${receiverName(picture)}`);
  try {
    const uri = rubyUriParse(picture.replaceAll("https:https", "https"));
    setQuery(uri, uri.query === null ? null : stripSize(uri.query));
    return rubyUriToString(uri);
  } catch (error) {
    if (error instanceof RubyUriError) throw new AuthHashError(error.message);
    throw error;
  }
}

// `raw_info[key]` for a parsed userinfo (or tokeninfo) answer of any JSON shape, in Ruby 3.4's wording when the receiver has no such reader.
// A String answers the key when it holds it as a substring.
export function rubyIndex(value: unknown, key: string): unknown {
  if (isHash(value)) return value[key] ?? null;
  if (typeof value === "string") return value.includes(key) ? key : null;
  if (Array.isArray(value) || typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value)))
    throw new AuthHashError("no implicit conversion of String into Integer");
  const name =
    value === null || value === undefined ? "nil" : typeof value === "boolean" ? String(value) : "an instance of Float";
  throw new AuthHashError(`undefined method '[]' for ${name}`);
}

// OmniAuth's `auth_hash` for a userinfo answer: `uid { raw_info['sub'] }` and the pruned `info` block. Anything Ruby raises while building them
// is an AuthHashError.
export function googleAuthData(rawInfo: unknown): GoogleAuthData {
  const read = (key: string) => rubyIndex(rawInfo, key);
  const sub = read("sub");
  const info = prune({
    name: read("name"),
    email: truthy(read("email_verified")) ? read("email") : null,
    unverified_email: read("email"),
    email_verified: read("email_verified"),
    image: googleImageUrl(read("picture")),
  });
  return {
    uid: sub === null || sub === undefined ? null : String(sub),
    info: info as GoogleAuthData["info"],
    rawInfo: isHash(rawInfo) ? prune(rawInfo) : (rawInfo as string),
  };
}

// ActiveModel::Type::Boolean#cast
const FALSE_VALUES = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
function castBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return !FALSE_VALUES.has(value as never);
}

const presence = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

// `reported_google_email`
export function reportedGoogleEmail(data: GoogleAuthData): string | null {
  const first = presence(data.info.email);
  if (first !== null) return first;
  // `data.dig("extra", "raw_info", "email")`: a String has no #dig, which Rails does not rescue.
  if (typeof data.rawInfo === "string") throw new Error("String does not have #dig method");
  return presence(data.rawInfo.email);
}

// `verified_google_email`: an address Google has not vouched for never matches or creates a row.
export function verifiedGoogleEmail(data: GoogleAuthData): string | null {
  if (typeof data.rawInfo === "string" && (data.info.email_verified ?? null) === null)
    throw new Error("String does not have #dig method");
  const verified = data.info.email_verified ?? (data.rawInfo as Hash).email_verified;
  return castBoolean(verified) === true ? reportedGoogleEmail(data) : null;
}

// `deleted_google_placeholder?` and the check of the first lookup: the address support frees on a closed account.
export const isDeletedPlaceholderEmail = (email: unknown) =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${DELETED_ACCOUNT_EMAIL_DOMAIN}`);
