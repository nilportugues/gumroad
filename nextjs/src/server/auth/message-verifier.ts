// Port of `Rails.application.message_verifier(name).generate(data, purpose:)` as Gumroad configures
// it: the JSON serializer with purpose metadata, a key derived from secret_key_base with the
// verifier's name as the salt (PBKDF2-SHA256, 1000 iterations, 64 bytes), HMAC-SHA1.
import { createHmac, pbkdf2Sync } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { encodeRailsJson } from "./rails-cookies.ts";

const KEY_ITERATIONS = 1000;
const KEY_BYTES = 64;

export function railsMessageVerifierGenerate(verifierName: string, data: unknown, purpose: string): string {
  const secretKeyBase = getConfig("SECRET_KEY_BASE");
  if (!secretKeyBase) throw new Error("Missing config SECRET_KEY_BASE (must match the Rails app)");
  const key = pbkdf2Sync(secretKeyBase, verifierName, KEY_ITERATIONS, KEY_BYTES, "sha256");
  const encoded = Buffer.from(encodeRailsJson({ _rails: { data, pur: purpose } }), "utf8").toString("base64");
  return `${encoded}--${createHmac("sha1", key).update(encoded).digest("hex")}`;
}
