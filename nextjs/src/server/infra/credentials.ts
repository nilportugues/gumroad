import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { railsEnv, railsRoot } from "./rails-env.ts";

// Port of Rails.application.credentials: ActiveSupport::EncryptedConfiguration over
// config/credentials/<env>.yml.enc (or config/credentials.yml.enc), keyed by RAILS_MASTER_KEY or
// the matching .key file. A missing file or key yields {} exactly as Rails does without
// `config.require_master_key`.

export type Credentials = Record<string, unknown>;

const CIPHER = "aes-128-gcm";

export function decryptEncryptedFile(contents: string, hexKey: string): string {
  const [data, iv, authTag] = contents.trim().split("--");
  if (data === undefined || iv === undefined || authTag === undefined) {
    throw new Error("Invalid encrypted credentials message");
  }
  const decipher = createDecipheriv(CIPHER, Buffer.from(hexKey, "hex"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const marshalled = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  return unmarshalString(marshalled);
}

// EncryptedFile pins `serializer: Marshal`, so the plaintext is a Marshal-dumped String. Only that
// shape (with or without an encoding ivar) is accepted.
function unmarshalString(bytes: Buffer): string {
  if (bytes[0] !== 4 || bytes[1] !== 8) throw new Error("Unsupported Marshal version");
  let offset = 2;
  if (bytes[offset] === 0x49 /* I: object with ivars */) offset += 1;
  if (bytes[offset] !== 0x22 /* ": String */) throw new Error("Credentials payload is not a Marshal String");
  offset += 1;
  const { value: length, next } = readMarshalLong(bytes, offset);
  return bytes.subarray(next, next + length).toString("utf8");
}

function readMarshalLong(bytes: Buffer, offset: number): { value: number; next: number } {
  const c = (bytes[offset] ?? 0) << 24 >> 24; // signed byte
  if (c === 0) return { value: 0, next: offset + 1 };
  if (c > 4) return { value: c - 5, next: offset + 1 };
  if (c < -4) return { value: c + 5, next: offset + 1 };
  let value = 0;
  const count = Math.abs(c);
  for (let i = 0; i < count; i++) value |= (bytes[offset + 1 + i] ?? 0) << (8 * i);
  if (c < 0) value -= 2 ** (8 * count);
  return { value, next: offset + 1 + count };
}

export function parseCredentialsYaml(content: string): Credentials {
  // Psych is YAML 1.1 (yes/no/on/off booleans, 0-prefixed octals); match it.
  const parsed: unknown = parseYaml(content, { version: "1.1" });
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Credentials;
}

function readKey(keyPath: string): string | undefined {
  const fromEnv = process.env.RAILS_MASTER_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  if (existsSync(keyPath)) return readFileSync(keyPath, "latin1").trim();
  return undefined;
}

export function loadCredentials(root = railsRoot(), env = railsEnv()): Credentials {
  const envContent = path.join(root, "config/credentials", `${env}.yml.enc`);
  const envKey = path.join(root, "config/credentials", `${env}.key`);
  const contentPath = existsSync(envContent) ? envContent : path.join(root, "config/credentials.yml.enc");
  const keyPath = existsSync(envKey) ? envKey : path.join(root, "config/master.key");

  const key = readKey(keyPath);
  if (key === undefined || !existsSync(contentPath)) return {};
  return parseCredentialsYaml(decryptEncryptedFile(readFileSync(contentPath, "utf8"), key));
}
