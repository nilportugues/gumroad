// The auth hash omniauth-google-oauth2 1.1.2 builds from the userinfo answer (`uid`, `info`, `extra`), and the reads
// User::SocialGoogle makes of it (app/models/concerns/user/social_google.rb). Nothing here writes; the account lookups and the avatar attach
// that consume it are not ported (parity-debt.md).
type Hash = Record<string, unknown>;
const isHash = (value: unknown): value is Hash => value !== null && typeof value === "object" && !Array.isArray(value);

export const DELETED_ACCOUNT_EMAIL_DOMAIN = "deleted.invalid";

export type GoogleAuthData = {
  uid: string | null;
  info: { name?: string; email?: string; unverified_email?: string; email_verified?: unknown; image?: string };
  rawInfo: Hash;
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

// CGI.parse then URI.encode_www_form of what is left once `sz` is gone; nil when nothing is. Form encoding: space is "+", and "*-._" and
// alphanumerics stay.
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("%20", "+")
    .replace(/[!'()~]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function stripSize(query: string): string | null {
  const grouped = new Map<string, (string | null)[]>();
  for (const pair of query.split(/[&;]/u)) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const unescape = (text: string) => decodeURIComponent(text.replaceAll("+", " "));
    const key = unescape(at === -1 ? pair : pair.slice(0, at));
    const entry = at === -1 ? null : unescape(pair.slice(at + 1));
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  grouped.delete("sz");
  if (grouped.size === 0) return null;
  // CGI.parse keeps a key with no "=" as an empty list, which encode_www_form writes as an empty segment.
  return [...grouped]
    .map(([key, entries]) =>
      entries
        .filter((entry) => entry !== null)
        .map((entry) => `${formEncode(key)}=${formEncode(entry!)}`)
        .join("&"),
    )
    .join("&");
}

// `image_url`: the picture with a doubled scheme repaired and the query rewritten without `sz`.
export function googleImageUrl(picture: unknown): string | null {
  if (!truthy(picture) || typeof picture !== "string") return null;
  const fixed = picture.replace("https:https", "https");
  // URI.parse raises on anything outside RFC 3986 and the callback would 500: this port does not guess.
  if (/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/u.test(fixed)) throw new Error("not ported: a picture URL URI.parse rejects");
  const hash = fixed.indexOf("#");
  const withoutFragment = hash === -1 ? fixed : fixed.slice(0, hash);
  const fragment = hash === -1 ? "" : fixed.slice(hash);
  const question = withoutFragment.indexOf("?");
  if (question === -1) return fixed;
  const query = stripSize(withoutFragment.slice(question + 1));
  return `${withoutFragment.slice(0, question)}${query === null ? "" : `?${query}`}${fragment}`;
}

// OmniAuth's `auth_hash` for a userinfo answer: `uid { raw_info['sub'] }` and the pruned `info` block.
export function googleAuthData(rawInfo: unknown): GoogleAuthData {
  const raw = isHash(rawInfo) ? rawInfo : {};
  const sub = raw.sub;
  const info = prune({
    name: raw.name,
    email: truthy(raw.email_verified) ? raw.email : null,
    unverified_email: raw.email,
    email_verified: raw.email_verified,
    image: googleImageUrl(raw.picture),
  });
  return {
    uid: sub === null || sub === undefined ? null : String(sub),
    info: info as GoogleAuthData["info"],
    rawInfo: prune(raw),
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
  return presence(data.info.email) ?? presence(data.rawInfo.email);
}

// `verified_google_email`: an address Google has not vouched for never matches or creates a row.
export function verifiedGoogleEmail(data: GoogleAuthData): string | null {
  const verified = data.info.email_verified ?? data.rawInfo.email_verified;
  return castBoolean(verified) === true ? reportedGoogleEmail(data) : null;
}

// `deleted_google_placeholder?` and the check of the first lookup: the address support frees on a closed account.
export const isDeletedPlaceholderEmail = (email: unknown) =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${DELETED_ACCOUNT_EMAIL_DOMAIN}`);
