// Port of app/modules/obfuscate_ids.rb. External IDs are in URLs, emails and API payloads
// already issued, so output must match Ruby byte for byte; see obfuscate-ids.test.ts.
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const MAX_BITS_FOR_NUMERIC_ENCRYPTION = 30;
const MAX_NUMERIC_ID = 2 ** MAX_BITS_FOR_NUMERIC_ENCRYPTION - 1;
// Ruby's OpenSSL::Cipher never had an IV set, which OpenSSL treats as all zeros.
const ZERO_IV = Buffer.alloc(16);

type Keys = { cipherKey: string; numericCipherKey: number };

function envKeys(): Keys {
  const cipherKey = process.env.OBFUSCATE_IDS_CIPHER_KEY;
  const numericCipherKey = process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY;
  if (!cipherKey || !numericCipherKey) throw new Error("OBFUSCATE_IDS_* keys are not configured");
  return { cipherKey, numericCipherKey: rubyToI(numericCipherKey) };
}

// Ruby String#to_i: leading optional sign and digits, ignoring the rest; 0 when none.
function rubyToI(value: string): number {
  const match = /^\s*([+-]?\d[\d_]*)/u.exec(value);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

// Ruby Base64.urlsafe_decode64 delegates to strict_decode64, which raises on anything a
// lenient decoder like Buffer.from(..., "base64url") would silently accept.
function rubyUrlsafeDecode64(input: string): Buffer | null {
  let normalized = input;
  if (!normalized.endsWith("=") && normalized.length % 4 !== 0) {
    normalized = normalized.padEnd((normalized.length + 3) & ~3, "=");
  }
  normalized = normalized.replaceAll("-", "+").replaceAll("_", "/");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) return null;
  return Buffer.from(normalized, "base64");
}

function aesKey(cipherKey: string): Buffer {
  return createHash("sha256").update(cipherKey).digest();
}

export function encrypt(id: number | bigint | string, { padding = true }: { padding?: boolean } = {}, keys: Keys = envKeys()): string {
  const cipher = createCipheriv("aes-256-cbc", aesKey(keys.cipherKey), ZERO_IV);
  const encoded = Buffer.concat([cipher.update(id.toString()), cipher.final()]).toString("base64url");
  return padding ? encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=") : encoded;
}

export function decrypt(externalId: string, keys: Keys = envKeys()): number | null {
  const bytes = rubyUrlsafeDecode64(externalId);
  if (!bytes) return null;
  try {
    const decipher = createDecipheriv("aes-256-cbc", aesKey(keys.cipherKey), ZERO_IV);
    return rubyToI(Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

// Ruby indexes past the end of the unpadded key string as nil.to_i == 0, so the key's bits
// align from the left and any missing bits count as zero.
function xor(a: string, b: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += String(Number(a[i] ?? 0) ^ Number(b[i] ?? 0));
  return out;
}

const reverse = (s: string) => [...s].reverse().join("");

export function encryptNumeric(id: number, keys: Keys = envKeys()): number {
  if (id > MAX_NUMERIC_ID) throw new RangeError(`Numeric encryption does not support ids greater than ${MAX_NUMERIC_ID}`);
  const extended = id.toString(2).padStart(MAX_BITS_FOR_NUMERIC_ENCRYPTION, "0");
  return parseInt(reverse(xor(extended, keys.numericCipherKey.toString(2), MAX_BITS_FOR_NUMERIC_ENCRYPTION)), 2);
}

export function decryptNumeric(encryptedId: number, keys: Keys = envKeys()): number {
  const binary = reverse(encryptedId.toString(2).padStart(MAX_BITS_FOR_NUMERIC_ENCRYPTION, "0"));
  return parseInt(xor(binary, keys.numericCipherKey.toString(2), MAX_BITS_FOR_NUMERIC_ENCRYPTION), 2);
}
