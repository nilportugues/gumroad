// Port of `Rails.application.message_verifier(name).generate(data, purpose:)` as Gumroad configures
// it: the JSON serializer with purpose metadata, a key derived from secret_key_base with the
// verifier's name as the salt (PBKDF2-SHA256, 1000 iterations, 64 bytes), HMAC-SHA1.
import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { encodeRailsJson } from "./rails-cookies.ts";

const KEY_ITERATIONS = 1000;
const KEY_BYTES = 64;

function verifierKey(verifierName: string): Buffer {
  const secretKeyBase = getConfig("SECRET_KEY_BASE");
  if (!secretKeyBase) throw new Error("Missing config SECRET_KEY_BASE (must match the Rails app)");
  return pbkdf2Sync(secretKeyBase, verifierName, KEY_ITERATIONS, KEY_BYTES, "sha256");
}

// `expiresAt` is `expires_in:` resolved to a time: metadata carries it as `exp`, UTC iso8601 with milliseconds.
export function railsMessageVerifierGenerate(verifierName: string, data: unknown, purpose: string, options: { expiresAt?: Date } = {}): string {
  const key = verifierKey(verifierName);
  const metadata = { data, ...(options.expiresAt ? { exp: options.expiresAt.toISOString() } : {}), pur: purpose };
  const encoded = Buffer.from(encodeRailsJson({ _rails: metadata }), "utf8").toString("base64");
  return `${encoded}--${createHmac("sha1", key).update(encoded).digest("hex")}`;
}

// `message_verifier(name).verified(token, purpose:)`: the payload, or null for anything that does not verify (bad shape, bad
// signature, another purpose, expired).
export function railsMessageVerifierVerified(verifierName: string, token: string, purpose: string, now: Date = new Date()): unknown {
  const separator = token.indexOf("--");
  if (separator === -1 || token.indexOf("--", separator + 2) !== -1) return null;
  const encoded = token.slice(0, separator);
  const digest = Buffer.from(token.slice(separator + 2));
  const expected = Buffer.from(createHmac("sha1", verifierKey(verifierName)).update(encoded).digest("hex"));
  if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) return null;
  let envelope: { _rails?: { data?: unknown; message?: unknown; exp?: string | null; pur?: string | null } };
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const metadata = envelope._rails;
  if (metadata === undefined || metadata === null || typeof metadata !== "object") return null;
  if ((metadata.pur ?? null) !== purpose) return null;
  if (metadata.exp != null && Date.parse(metadata.exp) <= now.getTime()) return null;
  return metadata.data ?? null;
}
