// Port of ActionController::RequestForgeryProtection#form_authenticity_token (global token, Rails 7.1+):
// HMAC the session's real token with "!real_csrf_token", then mask it with a one-time pad, so Rails
// accepts tokens minted by Next.js for forms it still handles.
import { createHmac, randomBytes } from "node:crypto";

const AUTHENTICITY_TOKEN_LENGTH = 32;
const GLOBAL_CSRF_TOKEN_IDENTIFIER = "!real_csrf_token";

// Buffer's base64 decoder accepts both the strict and the URL-safe alphabet, as Rails' fallback does.
const decode = (token: string) => Buffer.from(token, "base64");
const encode = (bytes: Buffer) => bytes.toString("base64url");

export function globalCsrfToken(sessionCsrfToken: string): Buffer {
  return createHmac("sha256", decode(sessionCsrfToken)).update(GLOBAL_CSRF_TOKEN_IDENTIFIER).digest();
}

export function maskToken(rawToken: Buffer, oneTimePad: Buffer = randomBytes(AUTHENTICITY_TOKEN_LENGTH)): string {
  const encrypted = Buffer.alloc(rawToken.length);
  for (let i = 0; i < rawToken.length; i++) encrypted[i] = (oneTimePad[i] ?? 0) ^ (rawToken[i] ?? 0);
  return encode(Buffer.concat([oneTimePad, encrypted]));
}

export function unmaskToken(maskedToken: string): Buffer {
  const bytes = decode(maskedToken);
  const pad = bytes.subarray(0, AUTHENTICITY_TOKEN_LENGTH);
  const encrypted = bytes.subarray(AUTHENTICITY_TOKEN_LENGTH);
  return Buffer.from(encrypted.map((byte, i) => byte ^ (pad[i] ?? 0)));
}

export function formAuthenticityToken(sessionCsrfToken: string): string {
  return maskToken(globalCsrfToken(sessionCsrfToken));
}
