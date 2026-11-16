// PaypalWebhookVerifier and PaypalPartnerRestCredentials (app/business/payments/events/paypal/paypal_webhook_verifier.rb,
// app/business/payments/paypal_partner_rest_credentials.rb), plus the scheduling half of PaypalEventHandler.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { getNamespacedRedis } from "../infra/redis.ts";
import { rubyToI } from "../mail/mailer-info.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { activeSupportJson, isBlank } from "./json-guards.ts";

const REQUIRED_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-cert-url",
  "paypal-auth-algo",
  "paypal-transmission-time",
] as const;
const TOKEN_KEY = "token_header";
const API_MAX_TRIES = 3;
const API_RETRY_TIMEOUT_MS = 2000;
const VERIFY_TIMEOUT_MS = 30_000;
const HOLD_BACK_SECONDS = 600;

// PaypalEventType::ORDER_API_EVENTS and MERCHANT_ACCOUNT_EVENTS, which are handled at once.
const IMMEDIATE_EVENTS = new Set([
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.CAPTURE.REFUNDED",
  "MERCHANT.ONBOARDING.COMPLETED",
  "MERCHANT.PARTNER-CONSENT.REVOKED",
  "CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED",
  "CUSTOMER.MERCHANT-INTEGRATION.PRODUCT-SUBSCRIPTION-UPDATED",
  "CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED",
  "IDENTITY.AUTHORIZATION-CONSENT.REVOKED",
  "CUSTOMER.MERCHANT-INTEGRATION.SELLER-CONSENT-GRANTED",
]);

// config/initializers/paypal.rb
export const restEndpoint = (): string =>
  railsEnv() === "production" ? "https://api.paypal.com" : "https://api.sandbox.paypal.com";

export const paypalEventDelaySeconds = (eventType: unknown): number | null =>
  typeof eventType === "string" && IMMEDIATE_EVENTS.has(eventType) ? null : HOLD_BACK_SECONDS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type TokenResponse = { token_type?: unknown; access_token?: unknown; expires_in?: unknown };

// HTTParty parses a JSON content type into a Hash and leaves anything else a String; `response["x"]` on a String is a substring
// lookup, so a body that is not a JSON object has no token.
async function parsedBody(response: Response, text: string): Promise<unknown> {
  if (
    !/^(?:application\/json|text\/json|application\/(?:[a-z.+-]*\+)?json)\b/iu.test(
      response.headers.get("content-type") ?? "",
    )
  )
    return text;
  if (text.trim() === "") return null;
  return JSON.parse(text);
}

const rubyToS = (value: unknown): string =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);

// PaypalPartnerRestCredentials#auth_token: the cached header, else a client-credentials token, cached for its lifetime.
export async function partnerAuthToken(): Promise<string> {
  const redis = getNamespacedRedis("paypal_partner_rest_auth_token");
  const cached = await redis.get(TOKEN_KEY);
  if (cached !== null) return cached;

  const basic = Buffer.from(
    `${getConfig("PAYPAL_PARTNER_CLIENT_ID") ?? ""}:${getConfig("PAYPAL_PARTNER_CLIENT_SECRET") ?? ""}`,
  ).toString("base64");
  // Only a failure to reach PayPal is retried; the parse and the Redis writes below sit outside the retry, as in Ruby.
  let response: Response;
  let text: string;
  for (let tries = API_MAX_TRIES; ; ) {
    try {
      response = await outboundFetch(`${restEndpoint()}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Language": "en_US",
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      text = await response.text();
      break;
    } catch (error) {
      tries -= 1;
      if (tries === 0) throw error;
      await sleep(API_RETRY_TIMEOUT_MS);
    }
  }
  const parsed = await parsedBody(response, text);
  // A String has no token_type and an Array or nil raises in `response["token_type"]`.
  if (typeof parsed !== "string" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)))
    throw new NotPortedError("a PayPal token response that is not an object");
  const body: TokenResponse = typeof parsed === "string" ? {} : (parsed as TokenResponse);
  const token = `${rubyToS(body.token_type)} ${rubyToS(body.access_token)}`;
  await redis.set(TOKEN_KEY, token);
  const lifetime =
    typeof body.expires_in === "number"
      ? Math.trunc(body.expires_in)
      : typeof body.expires_in === "string"
        ? rubyToI(body.expires_in)
        : 0;
  // EXPIRE with 0 or a negative lifetime deletes the key, as Redis does for Rails.
  await redis.expire(TOKEN_KEY, lifetime);
  return token;
}

export type PaypalVerification = { headers: Headers; rawBody: string; fallbackPayload: Record<string, unknown> };

// PaypalWebhookVerifier#valid?
export async function paypalWebhookIsValid({
  headers,
  rawBody,
  fallbackPayload,
}: PaypalVerification): Promise<boolean> {
  const webhookId = getConfig("PAYPAL_WEBHOOK_ID");
  if (webhookId === undefined) return false;
  if (REQUIRED_HEADERS.some((name) => isBlank(headers.get(name)))) return false;

  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(isBlank(rawBody) ? activeSupportJson(fallbackPayload) : rawBody);
  } catch {
    webhookEvent = fallbackPayload;
  }
  const body = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: webhookEvent,
  };

  try {
    const authorization = await partnerAuthToken();
    const response = await outboundFetch(`${restEndpoint()}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: activeSupportJson(body),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const parsed = await parsedBody(response, await response.text());
    if (typeof parsed === "string") return false;
    // nil[] and Array#[] with a String raise, and neither error is rescued.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new NotPortedError("a PayPal verification answer that is not an object");
    return response.status === 200 && (parsed as { verification_status?: unknown }).verification_status === "SUCCESS";
  } catch (error) {
    // The verifier rescues JSON::ParserError, HTTParty::Error and INTERNET_EXCEPTIONS and answers false; a Redis failure and the cases above are not its to rescue.
    if (error instanceof NotPortedError || isRedisFailure(error)) throw error;
    return false;
  }
}

export function isRedisFailure(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";
  return (
    name === "MaxRetriesPerRequestError" ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "NR_CLOSED"].includes(code)
  );
}
