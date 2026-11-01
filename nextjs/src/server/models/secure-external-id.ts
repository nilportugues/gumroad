// Port of SecureExternalId.encrypt_id (app/models/concerns/secure_external_id.rb): an AES-256-GCM
// MessageEncryptor message (ActiveSupport 8.1, JSON serializer) of the record's model, id, expiry and
// scope, wrapped in a versioned, URL-safe envelope. Only the encrypting half is ported: the links Node
// writes into emails are opened by Rails.
import { createCipheriv, randomBytes } from "node:crypto";

import { digConfig, digConfigName, getConfig } from "../infra/config.ts";

export class SecureExternalIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureExternalId::Error";
  }
}

const GCM_IV_BYTES = 12;
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
