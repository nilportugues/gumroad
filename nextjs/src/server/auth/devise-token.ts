// Devise::TokenGenerator#digest: the HMAC-SHA256 of a token under a key derived per column from
// DEVISE_SECRET_KEY (ActiveSupport::KeyGenerator, PBKDF2-HMAC-SHA1, 2**16 rounds, 64 bytes).
import { createHmac, pbkdf2Sync } from "node:crypto";

import { getRequiredConfig } from "../infra/config.ts";

const KEY_ITERATIONS = 2 ** 16;
const KEY_LENGTH = 64;

const keys = new Map<string, Buffer>();

function keyFor(column: string): Buffer {
  const secret = getRequiredConfig("DEVISE_SECRET_KEY");
  const cacheKey = `${secret}\0${column}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = pbkdf2Sync(secret, `Devise ${column}`, KEY_ITERATIONS, KEY_LENGTH, "sha1");
    keys.set(cacheKey, key);
  }
  return key;
}

export function deviseTokenDigest(column: string, value: string): string {
  return createHmac("sha256", keyFor(column)).update(value).digest("hex");
}
