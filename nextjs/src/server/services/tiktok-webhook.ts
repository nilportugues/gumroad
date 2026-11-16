// app/services/tiktok_webhook.rb: TikTok signs `t=<unix>,s=<hex>` over "<timestamp>.<raw body>".
import { createHmac, timingSafeEqual } from "node:crypto";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { getConfig } from "../infra/config.ts";

import { isBlank } from "./instagram-signed-request.ts";

const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;

export type TiktokPayload = Record<string, unknown>;

export class TiktokWebhook {
  constructor(private readonly secret: string | undefined = getConfig("TIKTOK_CLIENT_SECRET")) {}

  // The payload when the signature and timestamp hold, null otherwise. A body that is not valid UTF-8 or carries comments goes to
  // Rails, whose JSON parser reads them differently.
  parse(rawBody: Uint8Array, signature: string | null, now: Date = new Date()): TiktokPayload | null {
    const body = Buffer.from(rawBody);
    if (isBlank(body.toString("latin1")) || isBlank(signature) || isBlank(this.secret)) return null;

    const [timestamp, provided] = timestampAndDigest(signature!);
    if (isBlank(timestamp) || isBlank(provided) || !/^\d+$/u.test(timestamp!)) return null;

    const expected = createHmac("sha256", this.secret!)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex");
    const providedBytes = Buffer.from(provided!);
    if (providedBytes.length !== Buffer.byteLength(expected) || !timingSafeEqual(providedBytes, Buffer.from(expected)))
      return null;
    const age = BigInt(Math.floor(now.getTime() / 1000)) - BigInt(timestamp!);
    if ((age < 0n ? -age : age) > BigInt(MAX_TIMESTAMP_AGE_SECONDS)) return null;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new HandBackToRails("a signed body that is not UTF-8");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (/\/[*/]/u.test(text)) throw new HandBackToRails("a body with comments");
      return null;
    }
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as TiktokPayload)
      : null;
  }

  // `payload["user_openid"].presence`
  openId(payload: TiktokPayload): string | null {
    if (Object.keys(payload).length === 0) return null;
    const value = payload.user_openid;
    if (value === undefined || value === null || value === false) return null;
    if (typeof value === "string") return isBlank(value) ? null : value;
    if (Array.isArray(value) && value.length === 0) return null;
    // Anything else would reach a SQL comparison with a non-string.
    throw new HandBackToRails("an open id that is not a string");
  }
}

// signature.to_s.split(",") into key=value pairs: both parts present, the last pair for a key wins.
function timestampAndDigest(signature: string): [string | undefined, string | undefined] {
  const parts = new Map<string, string>();
  for (const pair of signature.split(",")) {
    const index = pair.indexOf("=");
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? undefined : pair.slice(index + 1);
    if (!isBlank(key) && value !== undefined && !isBlank(value)) parts.set(key, value);
  }
  return [parts.get("t"), parts.get("s")];
}
