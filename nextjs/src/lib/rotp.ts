// ROTP 6.3's TOTP#at with active_model_otp 2.3's defaults (6 digits, 30-second interval, SHA-1),
// which is what User#otp_code returns.
import { createHmac } from "node:crypto";

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
  for (let counter = Math.floor((now - driftBehindSeconds) / INTERVAL_SECONDS); counter <= Math.floor(now / INTERVAL_SECONDS); counter++) {
    if (code !== "" && code === hotp(secret, counter)) matched = true;
  }
  return matched;
}
