// ROTP 6.3's TOTP#at with active_model_otp 2.3's defaults (6 digits, 30-second interval, SHA-1),
// which is what User#otp_code returns.
import { createHmac, randomBytes } from "node:crypto";

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const INTERVAL_SECONDS = 30;

export class Base32Error extends Error {}

// ROTP::Base32.decode: "=" dropped, upcased, a raise on any other character outside the alphabet,
// and trailing bits that do not fill a byte ignored.
export function base32Decode(secret: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of secret.replaceAll("=", "").toUpperCase()) {
    const quint = BASE32_CHARS.indexOf(char);
    if (quint === -1) throw new Base32Error(`Invalid Base32 Character - '${char}'`);
    buffer = ((buffer << 5) | quint) & 0xffff;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ROTP::OTP#generate_otp: dynamic truncation of HMAC-SHA1 over the big-endian 8-byte counter.
export function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

// TOTP#at(time): the interval counter from whole Unix seconds.
export function totpAt(secret: string, time: Date): string {
  return hotp(secret, Math.floor(Math.floor(time.getTime() / 1000) / INTERVAL_SECONDS));
}

// ROTP::TOTP#verify(code, drift_behind:) as active_model_otp's authenticate_totp calls it: every interval counter from `drift`
// seconds ago to now is tried, and the code must match byte for byte.
export function verifyTotp(secret: string, code: string, driftBehindSeconds: number, time: Date): boolean {
  const now = Math.floor(time.getTime() / 1000);
  let matched = false;
  for (
    let counter = Math.floor((now - driftBehindSeconds) / INTERVAL_SECONDS);
    counter <= Math.floor(now / INTERVAL_SECONDS);
    counter++
  ) {
    if (code !== "" && code === hotp(secret, counter)) matched = true;
  }
  return matched;
}

// ROTP::Base32.encode: RFC 4648 without padding (the trailing bits are zero-filled).
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bitsLeft = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      out += BASE32_CHARS[(buffer >> (bitsLeft - 5)) & 31];
      bitsLeft -= 5;
    }
  }
  if (bitsLeft > 0) out += BASE32_CHARS[(buffer << (5 - bitsLeft)) & 31];
  return out;
}

const SECRET_BYTES = 20;

// ActiveModelOtp's `otp_random_secret`: ROTP::Base32.random(20), 160 random bits as 32 characters.
export const randomSecret = (): string => base32Encode(randomBytes(SECRET_BYTES));

// ERB::Util.url_encode: everything outside the RFC 3986 unreserved set is percent-encoded.
const urlEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// ROTP::TOTP#provisioning_uri(name) for a TOTP built with `issuer:` (OTP::URI#to_s).
export function provisioningUri(secret: string, accountName: string, issuer: string): string {
  const cleanIssuer = issuer.trim().replaceAll(":", "_");
  const label = [cleanIssuer, accountName.replace(/[\s\0]+$/u, "").replaceAll(":", "_")].map(urlEncode).join(":");
  return `otpauth://totp/${label}?secret=${urlEncode(secret)}&issuer=${urlEncode(cleanIssuer)}`;
}
