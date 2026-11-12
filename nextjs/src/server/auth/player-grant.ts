// ProductBuild.verified_player_grant (app/models/product_build.rb): an ActiveSupport::MessageEncryptor message (AES-256-GCM, url-safe
// Base64 of `data--iv--tag`) under the key `Rails.application.key_generator.generate_key("product_build_player_grant", 32)`, whose
// plaintext is the JSON envelope Rails wraps a purposed, expiring value in.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { NotPortedError } from "../models/user.ts";

export const PLAYER_GRANT_PURPOSE = "product_build_player";
export const PLAYER_SAVE_GRANT_PURPOSE = "product_build_player_save";

const SALT = "product_build_player_grant";
const KEY_ITERATIONS = 1000;
const KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SEPARATOR = "--";
// Base64 lengths of the 12-byte IV and the 16-byte tag, without and with padding.
const IV_LENGTH = 16;
const TAG_LENGTH_UNPADDED = 22;
const TAG_LENGTH_PADDED = 24;

// ProductBuild::PLAYER_GRANT_VALID_FOR
export const PLAYER_GRANT_VALID_FOR_MS = 12 * 60 * 60 * 1000;

export type PlayerGrant = Record<string, unknown>;

type Envelope = { _rails?: { data?: unknown; message?: unknown; exp?: unknown; pur?: unknown } };

// The key generator's digest depends on the app's load_defaults, which a grant cannot tell: try SHA-256 (Rails 7+), then SHA-1.
function decryptWith(digest: "sha256" | "sha1", message: string): string | null {
  const secret = getConfig("SECRET_KEY_BASE");
  if (secret === undefined || secret === "")
    throw new NotPortedError("ProductBuild.verified_player_grant", "SECRET_KEY_BASE is not set");
  // The parts are cut from the end by their encoded length, as MessageEncryptor does: a url-safe part may itself end in "-".
  const tagLength = message.endsWith("=") ? TAG_LENGTH_PADDED : TAG_LENGTH_UNPADDED;
  const tagStart = message.length - tagLength;
  const ivStart = tagStart - SEPARATOR.length - IV_LENGTH;
  if (
    ivStart - SEPARATOR.length < 1 ||
    message.slice(tagStart - SEPARATOR.length, tagStart) !== SEPARATOR ||
    message.slice(ivStart - SEPARATOR.length, ivStart) !== SEPARATOR
  )
    return null;
  const [data, iv, tag] = [
    message.slice(0, ivStart - SEPARATOR.length),
    message.slice(ivStart, ivStart + IV_LENGTH),
    message.slice(tagStart),
  ].map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer];
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", pbkdf2Sync(secret, SALT, KEY_ITERATIONS, KEY_BYTES, digest), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function openEnvelope(grant: string): Envelope["_rails"] | null {
  const plain = decryptWith("sha256", grant) ?? decryptWith("sha1", grant);
  if (plain === null) return null;
  try {
    return (JSON.parse(plain) as Envelope)._rails ?? null;
  } catch {
    return null;
  }
}

// When the grant stops being valid, for a replay that pins its clock to the instant a grant was issued.
export function playerGrantExpiresAt(grant: string): Date | null {
  const exp = openEnvelope(grant)?.exp;
  return typeof exp === "string" ? new Date(exp) : null;
}

// The grant's payload when it is valid, unexpired, issued for `purpose` and for this content-page token, else null.
export function verifiedPlayerGrant(
  grant: string,
  urlRedirectToken: string,
  purpose = PLAYER_GRANT_PURPOSE,
  now = new Date(),
): PlayerGrant | null {
  const meta = openEnvelope(grant);
  if (meta === undefined || meta === null || meta.pur !== purpose) return null;
  if (typeof meta.exp === "string" && new Date(meta.exp) <= now) return null;
  let payload: unknown = meta.data;
  if (payload === undefined && typeof meta.message === "string") {
    try {
      payload = JSON.parse(Buffer.from(meta.message, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as PlayerGrant;
  return record.token === urlRedirectToken ? record : null;
}

// The site prefix a grant names, without checking its expiry, purpose or token: a replay stores the build's files under it.
export function verifiedPlayerGrantUnchecked(grant: string): string | null {
  const data = openEnvelope(grant)?.data;
  const prefix = typeof data === "object" && data !== null ? (data as PlayerGrant).site_prefix : undefined;
  return typeof prefix === "string" ? prefix : null;
}

// ProductBuild#player_grant: `encrypt_and_sign(data, purpose:, expires_in:)` under the SHA-256 key the app's grants are made with. The
// envelope is `{"_rails":{"data":...,"exp":<ISO 8601, ms>,"pur":...}}` and each part is unpadded url-safe Base64.
export function issuePlayerGrant(
  data: PlayerGrant,
  { purpose = PLAYER_GRANT_PURPOSE, validForMs = PLAYER_GRANT_VALID_FOR_MS, now = new Date() } = {},
): string {
  const secret = getConfig("SECRET_KEY_BASE");
  if (secret === undefined || secret === "")
    throw new NotPortedError("ProductBuild#player_grant", "SECRET_KEY_BASE is not set");
  const envelope = { _rails: { data, exp: new Date(now.getTime() + validForMs).toISOString(), pur: purpose } };
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", pbkdf2Sync(secret, SALT, KEY_ITERATIONS, KEY_BYTES, "sha256"), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return [encrypted, iv, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(SEPARATOR);
}
