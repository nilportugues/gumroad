// SecureEncryptService.decrypt (app/services/secure_encrypt_service.rb): an AES-256-GCM MessageEncryptor message
// (`data--iv--tag`, Base64) whose plaintext is the JSON serialization of a string. A message that does not verify is nil.
import { createDecipheriv } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { NotPortedError } from "../models/user.ts";

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;

function key(): Buffer {
  const value = getConfig("SECURE_ENCRYPT_KEY");
  if (value === undefined || value === "" || Buffer.byteLength(value) !== KEY_BYTES) throw new NotPortedError("SecureEncryptService", "SECURE_ENCRYPT_KEY is missing or not 32 bytes");
  return Buffer.from(value);
}

export function secureDecrypt(encrypted: string): string | null {
  const secret = key();
  const parts = encrypted.split("--");
  if (parts.length !== 3) return null;
  const [data, iv, tag] = parts.map((part) => Buffer.from(part, "base64")) as [Buffer, Buffer, Buffer];
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    const value: unknown = JSON.parse(plain);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
