// Port of SecureExternalId.encrypt_id (app/models/concerns/secure_external_id.rb): an AES-256-GCM
// MessageEncryptor message (ActiveSupport 8.1, JSON serializer) of the record's model, id, expiry and
// scope, wrapped in a versioned, URL-safe envelope. `findBySecureExternalId` reads one back.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { digConfig, digConfigName, getConfig } from "../infra/config.ts";

export class SecureExternalIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureExternalId::Error";
  }
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_VERSION = 10;

type SecureExternalIdConfig = { primaryKeyVersion: string; keys: Record<string, string> };

// `GlobalConfig.dig(:secure_external_id, default: nil) || build_config_from_env`. A whole hash in the
// credentials is not read; the environment is what production sets.
function readConfig(): SecureExternalIdConfig {
  const whole = digConfig(["secure_external_id"], null);
  if (whole !== null && typeof whole === "object") {
    throw new SecureExternalIdError("SecureExternalId configuration in the credentials is not read by Node");
  }
  const primaryKeyVersion = digConfig(["secure_external_id", "primary_key_version"], null);
  if (typeof primaryKeyVersion !== "string" || primaryKeyVersion.trim() === "") throw new SecureExternalIdError("SecureExternalId configuration is missing");
  const keys: Record<string, string> = {};
  for (let version = 1; version <= MAX_KEY_VERSION; version++) {
    const key = getConfig(digConfigName("secure_external_id", "keys", String(version)));
    if (key !== undefined && key.trim() !== "") keys[String(version)] = key;
  }
  if (Object.keys(keys).length === 0) throw new SecureExternalIdError("keys are required in SecureExternalId config");
  if (!(primaryKeyVersion in keys)) throw new SecureExternalIdError(`Primary key version '${primaryKeyVersion}' not found in keys`);
  for (const [version, key] of Object.entries(keys)) {
    if (Buffer.byteLength(key) !== KEY_BYTES) throw new SecureExternalIdError(`Key for version '${version}' must be exactly 32 bytes for aes-256-gcm`);
  }
  return { primaryKeyVersion, keys };
}

export type SecureExternalIdOptions = {
  expiresAt?: Date | null;
  // OpenSSL::Cipher#random_iv
  randomIv?: (bytes: number) => Buffer;
};

// `record.secure_external_id(scope:, expires_at:)` for a record of class `model`.
export function secureExternalId(model: string, id: bigint | number, scope: string, options: SecureExternalIdOptions = {}): string {
  const config = readConfig();
  const exp = options.expiresAt == null ? null : Math.trunc(options.expiresAt.getTime() / 1000);
  const inner = `{"model":${JSON.stringify(model)},"id":${String(id)},"exp":${exp === null ? "null" : String(exp)},"scp":${JSON.stringify(scope)}}`;
  const iv = (options.randomIv ?? randomBytes)(GCM_IV_BYTES);
  if (iv.length !== GCM_IV_BYTES) throw new SecureExternalIdError("an AES-GCM IV is 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.keys[config.primaryKeyVersion]!), iv);
  // The JSON serializer writes the string as a JSON string; the message is data--iv--tag in Base64.
  const data = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]);
  const message = [data, iv, cipher.getAuthTag()].map((part) => part.toString("base64")).join("--");
  return Buffer.from(JSON.stringify({ v: config.primaryKeyVersion, d: message })).toString("base64url");
}

// `Model.decrypt_id(token, scope:)`: the id of a record of class `model`, or null for a token that is not
// well-formed, is for another model or scope, has expired, or does not decrypt under its key version.
export function decryptSecureExternalId(model: string, token: unknown, scope: string, now: Date = new Date()): string | null {
  if (typeof token !== "string") return null;
  const config = readConfig();
  try {
    const outer: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (outer === null || typeof outer !== "object" || Array.isArray(outer)) return null;
    const { v: version, d: message } = outer as { v?: unknown; d?: unknown };
    if (typeof version !== "string" || version === "" || typeof message !== "string" || message === "") return null;
    const key = config.keys[version];
    if (key === undefined) return null;
    const [data, iv, tag, ...rest] = message.split("--").map((part) => Buffer.from(part, "base64"));
    if (!data || !iv || !tag || rest.length > 0 || iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    const inner = JSON.parse(JSON.parse(plain) as string) as { model?: unknown; id?: unknown; exp?: unknown; scp?: unknown };
    if (inner.model !== model || inner.scp !== scope) return null;
    if (typeof inner.exp === "number" && Math.trunc(now.getTime() / 1000) > inner.exp) return null;
    return inner.id === undefined || inner.id === null ? null : String(inner.id);
  } catch {
    return null;
  }
}
