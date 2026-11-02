// app/services/instagram_signed_request.rb: Meta's `signed_request` of the deauthorize and data-deletion callbacks.
import { createHmac, timingSafeEqual } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";

const ALGORITHM = "HMAC-SHA256";
const CONFIRMATION_CODE_PATTERN = /^[0-9a-f]{48}$/u;
const CODE_PART_LENGTH = 24;
const BASE64_BODY = /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}==|[A-Za-z0-9+/_-]{3}=)?$/u;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// ActiveSupport's String#blank?
export const isBlank = (value: string | null | undefined): boolean => value === null || value === undefined || /^[\s\u0085]*$/u.test(value);

// Base64.urlsafe_decode64(value.ljust((value.length + 3) & ~3, "=")): strict decoding, so a stray character, bad padding or
// non-zero trailing bits raise ArgumentError (null here).
function decode(value: string): Buffer | null {
  const padded = value.padEnd((value.length + 3) & ~3, "=");
  const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
  if (!BASE64_BODY.test(padded)) return null;
  const tail = /([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/u.exec(standard)?.[1];
  if (tail !== undefined) {
    const last = BASE64_ALPHABET.indexOf(tail.replaceAll("=", "").at(-1)!);
    if ((tail.endsWith("==") && (last & 0xf) !== 0) || (tail.endsWith("=") && !tail.endsWith("==") && (last & 0x3) !== 0)) return null;
  }
  return Buffer.from(standard, "base64");
}

const hex = (secret: string, message: string | Buffer) => createHmac("sha256", secret).update(message).digest("hex");

const secureCompare = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export type InstagramPayload = { user_id: string | null };

export class InstagramSignedRequest {
  constructor(private readonly secret: string | undefined = getConfig("INSTAGRAM_APP_SECRET")) {}

  // The payload's user id as `to_s` writes it, or null when the request is not valid. Shapes whose Ruby behaviour the port does not
  // model (a payload that is not an object, a user id that is not a scalar) go to Rails.
  parse(value: string | null | undefined): InstagramPayload | null {
    if (isBlank(value) || isBlank(this.secret)) return null;
    const separator = value!.indexOf(".");
    const encodedSignature = separator === -1 ? value! : value!.slice(0, separator);
    const encodedPayload = separator === -1 ? "" : value!.slice(separator + 1);
    if (isBlank(encodedSignature) || isBlank(encodedPayload)) return null;

    const signature = decode(encodedSignature);
    if (signature === null) return null;
    const expected = createHmac("sha256", this.secret!).update(encodedPayload, "utf8").digest();
    if (signature.length !== expected.length || !secureCompare(signature, expected)) return null;

    const bytes = decode(encodedPayload);
    if (bytes === null) return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HandBackToRails("a signed payload that is not UTF-8");
    }
    return payloadOf(text);
  }

  confirmationCode(userId: string): string {
    const opaqueId = hex(this.secret!, `instagram-data-deletion:${userId}`).slice(0, CODE_PART_LENGTH);
    return `${opaqueId}${this.confirmationCodeSignature(opaqueId)}`;
  }

  validConfirmationCode(code: string | null | undefined): boolean {
    if (isBlank(this.secret) || !CONFIRMATION_CODE_PATTERN.test(code ?? "")) return false;
    const opaqueId = code!.slice(0, CODE_PART_LENGTH);
    const signature = code!.slice(-CODE_PART_LENGTH);
    return secureCompare(Buffer.from(signature), Buffer.from(this.confirmationCodeSignature(opaqueId)));
  }

  private confirmationCodeSignature(opaqueId: string): string {
    return hex(this.secret!, `instagram-data-deletion-status:${opaqueId}`).slice(0, CODE_PART_LENGTH);
  }
}

// JSON.parse(text) then `payload["algorithm"]` and `payload.fetch("user_id", nil)&.to_s`. The user id is read from the source text:
// Instagram ids exceed 2^53.
function payloadOf(text: string): InstagramPayload | null {
  const sources = new Map<unknown, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
      if (key === "user_id" && context?.source !== undefined) sources.set(this, context.source);
      return value;
    });
  } catch {
    // Ruby's parser also skips /* */ and // comments.
    if (/\/[*/]/u.test(text)) throw new HandBackToRails("a payload with comments");
    return null;
  }
  // A String payload answers nil to ["algorithm"]; the other scalars and an Array raise in Ruby.
  if (typeof parsed === "string") return null;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HandBackToRails("a payload that is not an object");
  const payload = parsed as Record<string, unknown>;
  const algorithm = payload.algorithm;
  if (typeof algorithm !== "string" || algorithm.toUpperCase() !== ALGORITHM) return null;
  const userId = payload.user_id;
  if (userId === undefined || userId === null) return { user_id: null };
  if (typeof userId === "string") return { user_id: userId };
  if (typeof userId === "boolean") return { user_id: String(userId) };
  if (typeof userId === "number") {
    const source = sources.get(payload) ?? String(userId);
    if (!/^-?\d+$/u.test(source)) throw new HandBackToRails("a user id that is not an integer");
    return { user_id: BigInt(source).toString() };
  }
  throw new HandBackToRails("a user id that is not a scalar");
}
