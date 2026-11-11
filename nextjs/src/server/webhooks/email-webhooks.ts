// The checks ForeignWebhooksController runs for SendGrid and Resend, and ResendEventInfo#invalid?.
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { decryptHeader, headerName, rubyToI, type MailerInfoField } from "../mail/mailer-info.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { isBlank } from "./json-guards.ts";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

export const SENDGRID_WEBHOOK_PUBLIC_KEY_ENV_VARS = [
  "SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_GR_CUSTOMERS_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_GR_CUSTOMERS_LEVEL_2_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_GUMROAD_FOLLOWER_CONFIRMATION_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_GUMROAD_TRANSACTIONS_WEBHOOK_PUBLIC_KEY",
] as const;

const secondsApart = (header: string, now: number): number => Math.abs(now / 1000 - rubyToI(header));

// ForeignWebhooksController#verify_sendgrid_signature: the reason the delivery cannot be trusted, or null.
export function sendgridSignatureError(rawBody: Uint8Array, headers: Headers, now: number = Date.now()): string | null {
  const publicKeys = SENDGRID_WEBHOOK_PUBLIC_KEY_ENV_VARS.map((name) => getConfig(name)).filter(
    (key): key is string => key !== undefined && !isBlank(key),
  );
  const signature = headers.get("x-twilio-email-event-webhook-signature");
  const timestamp = headers.get("x-twilio-email-event-webhook-timestamp");
  if (publicKeys.length === 0) return "No public keys configured";
  if (signature === null || isBlank(signature)) return "Missing signature";
  if (timestamp === null || isBlank(timestamp)) return "Missing timestamp";
  if (secondsApart(timestamp, now) > TIMESTAMP_TOLERANCE_SECONDS) return "Timestamp too old";
  // SendGrid::EventWebhook#verify_signature hashes "#{timestamp}#{payload}" and checks the DER signature over that digest.
  const signed = Buffer.concat([Buffer.from(timestamp), rawBody]);
  const decodedSignature = Buffer.from(signature, "base64");
  try {
    const verified = publicKeys.some((publicKey) => {
      const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
      try {
        return verify("sha256", signed, key, decodedSignature);
      } catch {
        return false;
      }
    });
    return verified ? null : "Invalid signature";
  } catch (error) {
    return `Verification raised: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ForeignWebhooksController#validate_resend_webhook: true when the Svix signature checks out. Every failure there is the same 400.
export function resendSignatureIsValid(rawBody: Uint8Array, headers: Headers, now: number = Date.now()): boolean {
  const secret = getConfig("RESEND_WEBHOOK_SECRET");
  const signatureHeader = headers.get("svix-signature");
  const timestamp = headers.get("svix-timestamp");
  const messageId = headers.get("svix-id");
  if (
    signatureHeader === null ||
    isBlank(signatureHeader) ||
    timestamp === null ||
    isBlank(timestamp) ||
    messageId === null ||
    isBlank(messageId)
  )
    return false;
  if (secondsApart(timestamp, now) > TIMESTAMP_TOLERANCE_SECONDS) return false;
  const comma = signatureHeader.indexOf(",");
  const signature = comma === -1 ? undefined : signatureHeader.slice(comma + 1);
  if (signature === undefined || isBlank(signature)) return false;
  if (secret === undefined) return false;
  const secretBytes = Buffer.from(secret.slice(secret.lastIndexOf("_") + 1), "base64");
  const expected = createHmac("sha256", secretBytes)
    .update(`${messageId}.${timestamp}.`)
    .update(rawBody)
    .digest("base64");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ResendEventInfo::TRACKED_EVENTS for Resend, inverted
const RESEND_EVENT_TYPES = new Set([
  "email.bounced",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.complained",
]);
const RESEND_HEADERS: MailerInfoField[] = [
  "mailer_class",
  "mailer_method",
  "mailer_args",
  "purchase_id",
  "charge_id",
  "workflow_ids",
  "post_id",
];
// Base64.strict_decode64
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// MailerInfo.parse_resend_webhook_header: the decrypted value of the header, nil when it is absent. Throws where Ruby raises.
function resendHeader(headers: unknown, field: MailerInfoField): string | null {
  if (headers === null || headers === undefined) return null;
  if (!Array.isArray(headers)) throw new Error("headers is not a list");
  const wanted = headerName(field).toLowerCase();
  const entry = headers.find((item: unknown) => {
    if (!isObject(item)) throw new Error("header is not a hash");
    if (typeof item.name !== "string") throw new Error("header name is not a string");
    return item.name.toLowerCase() === wanted;
  }) as Record<string, unknown> | undefined;
  const value = entry?.value;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("header value is not a string");
  const [, iv, encrypted] = value.split(":");
  if (iv === undefined || encrypted === undefined || !STRICT_BASE64.test(iv) || !STRICT_BASE64.test(encrypted))
    throw new Error("not strict base64");
  const decrypted = decryptHeader(value);
  // A byte string that is not UTF-8 raises in blank? and in the JSON parse; JS has already replaced it.
  if (decrypted.includes("�")) throw new NotPortedError("a Resend header that does not decrypt to UTF-8");
  return decrypted;
}

// ForeignWebhooksController#trackable_resend_event?: `!ResendEventInfo.new(event_json).invalid?`, true when anything raises.
export function resendEventIsTrackable(eventJson: Record<string, unknown>): boolean {
  try {
    const data = eventJson.data;
    // Only a missing `data` is certain to raise (nil["to"]); a String would answer [] and not raise.
    if (data === null || data === undefined) return true;
    if (!isObject(data)) throw new NotPortedError("a Resend payload whose data is not an object");
    if (!Array.isArray(data.to)) {
      if (data.to === null || data.to === undefined) return true;
      throw new NotPortedError("a Resend payload whose recipients are not a list");
    }
    const click = data.click;
    if (click !== null && click !== undefined && !isObject(click)) return true;
    const values = Object.fromEntries(
      RESEND_HEADERS.map((field) => [field, resendHeader(data.headers, field)] as const),
    );
    const workflowIds = values.workflow_ids;
    if (workflowIds !== null && workflowIds !== undefined && !isBlank(workflowIds)) {
      try {
        JSON.parse(workflowIds);
      } catch {
        throw new NotPortedError("Resend workflow ids Ruby's JSON parser may accept");
      }
    }
    // Time.zone.parse raises on nil and on a number, answers nil for a string it cannot read, and raises for an impossible date.
    const createdAt = data.created_at;
    if (typeof createdAt !== "string") return true;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u.test(createdAt))
      throw new NotPortedError("a Resend created_at Ruby's date parser may reject");
    const invalid =
      typeof eventJson.type !== "string" ||
      !RESEND_EVENT_TYPES.has(eventJson.type) ||
      isBlank(values.mailer_class) ||
      isBlank(values.mailer_method);
    return !invalid;
  } catch (error) {
    if (error instanceof NotPortedError) throw error;
    return true;
  }
}
