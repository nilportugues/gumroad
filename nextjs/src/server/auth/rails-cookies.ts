// Port of ActionDispatch's encrypted and signed cookie jars as Gumroad configures them:
// load_defaults 8.1 (AES-256-GCM, PBKDF2-SHA256 keys, JSON serializer, purpose metadata) plus the
// SHA1-derived keys that config/initializers/cookie_rotator.rb still accepts.
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_ITERATIONS = 1000; // Rails::Application#key_generator
const ENCRYPTED_COOKIE_SALT = "authenticated encrypted cookie";
const SIGNED_COOKIE_SALT = "signed cookie";
const ENCRYPTION_KEY_BYTES = 32;
const SIGNING_KEY_BYTES = 64; // KeyGenerator#generate_key default
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SEPARATOR = "--";
const SHA1_HEX_LENGTH = 40;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const LEGACY_ENVELOPE_PREFIX = '{"_rails":{"message":';
// U+2028 and U+2029 built from code points so the source stays plain ASCII.
const JSON_UNSAFE_FOR_HTML = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "gu");

// Index 0 is what Rails writes with; later entries are rotations it still reads.
export type RailsCookieSecrets = { encryption: Buffer[]; signing: Buffer[] };

export function deriveRailsCookieSecrets(secretKeyBase: string): RailsCookieSecrets {
  if (!secretKeyBase) throw new Error("secret_key_base is required to read Rails cookies");
  const derive = (salt: string, bytes: number, digest: "sha256" | "sha1") =>
    pbkdf2Sync(secretKeyBase, salt, KEY_ITERATIONS, bytes, digest);
  return {
    encryption: [derive(ENCRYPTED_COOKIE_SALT, ENCRYPTION_KEY_BYTES, "sha256"), derive(ENCRYPTED_COOKIE_SALT, ENCRYPTION_KEY_BYTES, "sha1")],
    signing: [derive(SIGNED_COOKIE_SALT, SIGNING_KEY_BYTES, "sha256"), derive(SIGNED_COOKIE_SALT, SIGNING_KEY_BYTES, "sha1")],
  };
}

export type WriteOptions = {
  // Embedded in the message, so Rails rejects the cookie after this even if the browser resends it.
  expiresAt?: Date | null;
  // Tests only: pins the IV so output can be compared byte for byte with Ruby's.
  iv?: Buffer;
  now?: Date;
};

export function readEncryptedCookie(secrets: RailsCookieSecrets, name: string, raw: string | undefined, now = new Date()): unknown {
  if (!raw) return null;
  return readWithPurposeFallback(name, (purpose) => decryptMessage(secrets.encryption, raw, purpose, now));
}

export function writeEncryptedCookie(secrets: RailsCookieSecrets, name: string, value: unknown, options: WriteOptions = {}): string {
  const key = secrets.encryption[0];
  if (!key) throw new Error("No encryption key");
  const plaintext = Buffer.from(legacyEnvelope(name, value, options.expiresAt ?? null), "utf8");
  const iv = options.iv ?? randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.alloc(0));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [ciphertext, iv, cipher.getAuthTag()].map((part) => part.toString("base64")).join(SEPARATOR);
}

export function readSignedCookie(secrets: RailsCookieSecrets, name: string, raw: string | undefined, now = new Date()): unknown {
  if (!raw) return null;
  return readWithPurposeFallback(name, (purpose) => verifyMessage(secrets.signing, raw, purpose, now));
}

export function writeSignedCookie(secrets: RailsCookieSecrets, name: string, value: unknown, options: WriteOptions = {}): string {
  const key = secrets.signing[0];
  if (!key) throw new Error("No signing key");
  const encoded = Buffer.from(legacyEnvelope(name, value, options.expiresAt ?? null), "utf8").toString("base64");
  return `${encoded}${SEPARATOR}${createHmac("sha1", key).update(encoded).digest("hex")}`;
}

// ActiveSupport::JSON.encode with escape_html_entities_in_json and escape_js_separators_in_json on,
// as the app configures them. Only safe for the strings, integers, arrays and hashes sessions hold.
export function encodeRailsJson(value: unknown): string {
  return JSON.stringify(value).replace(JSON_UNSAFE_FOR_HTML, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

type Unwrapped = { ok: true; serialized: string } | { ok: false };

// AbstractCookieJar#[]: try with the cookie's purpose, then without, for cookies written before
// use_cookies_with_metadata (those carry no envelope at all).
function readWithPurposeFallback(name: string, read: (purpose: string | null) => Unwrapped): unknown {
  const withPurpose = read(`cookie.${name}`);
  const result = withPurpose.ok ? withPurpose : read(null);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.serialized);
  } catch {
    return null;
  }
}

// MessageEncryptor with NullSerializer: the first key that authenticates decides, because Rails'
// rotator only falls through on format errors, not on expired or wrong-purpose content.
function decryptMessage(keys: Buffer[], message: string, purpose: string | null, now: Date): Unwrapped {
  const parts = extractGcmParts(message);
  if (!parts) return { ok: false };
  for (const key of keys) {
    const plaintext = decryptGcm(key, parts);
    if (plaintext !== null) return unwrapMetadata(plaintext, purpose, now);
  }
  return { ok: false };
}

function verifyMessage(keys: Buffer[], message: string, purpose: string | null, now: Date): Unwrapped {
  const separatorAt = message.length - SHA1_HEX_LENGTH - SEPARATOR.length;
  if (separatorAt <= 0 || message.slice(separatorAt, separatorAt + SEPARATOR.length) !== SEPARATOR) return { ok: false };
  const encoded = message.slice(0, separatorAt);
  const digest = Buffer.from(message.slice(separatorAt + SEPARATOR.length), "utf8");
  for (const key of keys) {
    const expected = Buffer.from(createHmac("sha1", key).update(encoded).digest("hex"), "utf8");
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
      const decoded = strictBase64(encoded);
      return decoded ? unwrapMetadata(decoded.toString("utf8"), purpose, now) : { ok: false };
    }
  }
  return { ok: false };
}

type GcmParts = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

// Rails slices the IV and tag off the end by their fixed encoded lengths rather than splitting.
function extractGcmParts(message: string): GcmParts | null {
  const tagLength = base64Length(GCM_TAG_BYTES);
  const ivLength = base64Length(GCM_IV_BYTES);
  const tagStart = message.length - tagLength;
  const ivStart = tagStart - SEPARATOR.length - ivLength;
  const dataEnd = ivStart - SEPARATOR.length;
  if (dataEnd < 0) return null;
  if (message.slice(tagStart - SEPARATOR.length, tagStart) !== SEPARATOR) return null;
  if (message.slice(dataEnd, ivStart) !== SEPARATOR) return null;
  const ciphertext = strictBase64(message.slice(0, dataEnd));
  const iv = strictBase64(message.slice(ivStart, ivStart + ivLength));
  const tag = strictBase64(message.slice(tagStart));
  if (!ciphertext || !iv || !tag || tag.length !== GCM_TAG_BYTES) return null;
  return { ciphertext, iv, tag };
}

function decryptGcm(key: Buffer, { ciphertext, iv, tag }: GcmParts): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.alloc(0));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ActiveSupport::Messages::Metadata with a NullSerializer, which always uses the legacy envelope:
// the cookie's JSON is base64'd into "message" beside "exp" and "pur".
function unwrapMetadata(plaintext: string, purpose: string | null, now: Date): Unwrapped {
  if (!plaintext.startsWith(LEGACY_ENVELOPE_PREFIX)) {
    return purpose === null ? { ok: true, serialized: plaintext } : { ok: false };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(plaintext);
  } catch {
    return { ok: false };
  }
  const meta = (envelope as { _rails?: { message?: unknown; exp?: unknown; pur?: unknown } })._rails;
  if (!meta || typeof meta.message !== "string") return { ok: false };
  if (meta.exp != null) {
    const expiresAt = typeof meta.exp === "string" ? Date.parse(meta.exp) : NaN;
    if (Number.isNaN(expiresAt) || now.getTime() >= expiresAt) return { ok: false };
  }
  if (String(meta.pur ?? "") !== (purpose ?? "")) return { ok: false };
  const decoded = strictBase64(meta.message);
  return decoded ? { ok: true, serialized: decoded.toString("utf8") } : { ok: false };
}

function legacyEnvelope(name: string, value: unknown, expiresAt: Date | null): string {
  const message = Buffer.from(encodeRailsJson(value), "utf8").toString("base64");
  return encodeRailsJson({ _rails: { message, exp: expiresAt ? expiresAt.toISOString() : null, pur: `cookie.${name}` } });
}

function strictBase64(value: string): Buffer | null {
  return value.length > 0 && STRICT_BASE64.test(value) ? Buffer.from(value, "base64") : null;
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
