import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCredentialsForTesting } from "../infra/config.ts";
import { encryptHeader, headerName } from "../mail/mailer-info.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { resendEventIsTrackable, resendSignatureIsValid, sendgridSignatureError } from "./email-webhooks.ts";
import { activeSupportJson, assertKeyOrderSurvives, assertPlainIntegers, isBlank } from "./json-guards.ts";
import { paypalEventDelaySeconds, paypalWebhookIsValid } from "./paypal-webhook.ts";
import { SignatureVerificationError, verifyStripeHeader } from "./stripe-signature.ts";

// The parity replay (parity/__tests__/foreign-webhooks.replay.test.ts) proves the routes against Rails' recordings with the secrets
// configured. These cover the deployments the recordings do not: nothing configured, and the helpers' own edge cases.
beforeEach(() => setCredentialsForTesting({}));
afterEach(() => {
  vi.unstubAllEnvs();
  setCredentialsForTesting(undefined);
});

const NOW = 1_600_112_502_000;

describe("verifyStripeHeader", () => {
  const payload = Buffer.from('{"id":"evt_1"}');
  const header = (timestamp: number, secret = "whsec", body = payload) =>
    `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;

  it("accepts a signature made with the secret inside the tolerance", () => {
    expect(() => verifyStripeHeader(payload, header(NOW / 1000), "whsec", () => NOW)).not.toThrow();
    expect(() => verifyStripeHeader(payload, header(NOW / 1000 - 300), "whsec", () => NOW)).not.toThrow();
  });

  it("accepts a timestamp in the future, as stripe-ruby does", () => {
    expect(() => verifyStripeHeader(payload, header(NOW / 1000 + 3600), "whsec", () => NOW)).not.toThrow();
  });

  it("rejects a timestamp more than 300 seconds old", () => {
    expect(() => verifyStripeHeader(payload, header(NOW / 1000 - 301), "whsec", () => NOW)).toThrow(
      SignatureVerificationError,
    );
  });

  it("rejects another secret, another body, a missing header and a header with no v1 signature", () => {
    expect(() => verifyStripeHeader(payload, header(NOW / 1000, "other"), "whsec", () => NOW)).toThrow(
      SignatureVerificationError,
    );
    expect(() => verifyStripeHeader(Buffer.from("{}"), header(NOW / 1000), "whsec", () => NOW)).toThrow(
      SignatureVerificationError,
    );
    expect(() => verifyStripeHeader(payload, null, "whsec", () => NOW)).toThrow(SignatureVerificationError);
    expect(() => verifyStripeHeader(payload, `t=${NOW / 1000},v0=abc`, "whsec", () => NOW)).toThrow(
      SignatureVerificationError,
    );
    expect(() => verifyStripeHeader(payload, "garbage", "whsec", () => NOW)).toThrow(SignatureVerificationError);
    expect(() => verifyStripeHeader(payload, "t=abc,v1=00", "whsec", () => NOW)).toThrow(SignatureVerificationError);
  });

  it("accepts any one of several v1 signatures", () => {
    const good = header(NOW / 1000);
    expect(() =>
      verifyStripeHeader(payload, `${good.split(",")[0]},v1=00,${good.split(",")[1]}`, "whsec", () => NOW),
    ).not.toThrow();
  });

  it("hands back what Ruby would raise on or read differently", () => {
    expect(() => verifyStripeHeader(payload, header(NOW / 1000), undefined, () => NOW)).toThrow(NotPortedError);
    expect(() => verifyStripeHeader(payload, "t=0x10,v1=00", "whsec", () => NOW)).toThrow(NotPortedError);
  });
});

describe("json guards", () => {
  it("refuses numbers Ruby would write differently", () => {
    expect(() => assertPlainIntegers('{"a":[1,-2,{"b":"1.5e3"}],"c":"x\\"1.0"}')).not.toThrow();
    for (const body of ['{"a":1.0}', '{"a":1e3}', '{"a":9007199254740993}', '{"a":[-0.5]}'])
      expect(() => assertPlainIntegers(body)).toThrow(NotPortedError);
  });

  it("refuses keys JS would reorder", () => {
    expect(() => assertKeyOrderSurvives({ a: { "01": 1 }, b: [{ c: 1 }] })).not.toThrow();
    expect(() => assertKeyOrderSurvives({ a: [{ "1": 1 }] })).toThrow(NotPortedError);
  });

  it("encodes like ActiveSupport::JSON", () => {
    expect(activeSupportJson({ a: "<b>&\u2028" })).toBe('{"a":"\\u003cb\\u003e\\u0026\\u2028"}');
  });

  it("reads blank like Object#blank?", () => {
    for (const value of [null, undefined, false, "", "  \n ", [], {}]) expect(isBlank(value)).toBe(true);
    for (const value of [0, true, "x", [0], { a: 1 }]) expect(isBlank(value)).toBe(false);
  });
});

describe("sendgridSignatureError", () => {
  it("reports a deployment with no public key configured", () => {
    const headers = new Headers({
      "x-twilio-email-event-webhook-signature": "sig",
      "x-twilio-email-event-webhook-timestamp": String(NOW / 1000),
    });
    expect(sendgridSignatureError(Buffer.from("[]"), headers, NOW)).toBe("No public keys configured");
  });

  it("names a missing signature, a missing timestamp and a stale timestamp once a key is configured", () => {
    vi.stubEnv("SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY", "MFkw");
    const stamp = String(NOW / 1000);
    expect(
      sendgridSignatureError(Buffer.from("[]"), new Headers({ "x-twilio-email-event-webhook-timestamp": stamp }), NOW),
    ).toBe("Missing signature");
    expect(
      sendgridSignatureError(Buffer.from("[]"), new Headers({ "x-twilio-email-event-webhook-signature": "s" }), NOW),
    ).toBe("Missing timestamp");
    expect(
      sendgridSignatureError(
        Buffer.from("[]"),
        new Headers({
          "x-twilio-email-event-webhook-signature": "s",
          "x-twilio-email-event-webhook-timestamp": String(NOW / 1000 - 301),
        }),
        NOW,
      ),
    ).toBe("Timestamp too old");
  });

  it("reports a key that does not parse as a raised verification", () => {
    vi.stubEnv("SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY", "MFkw");
    const headers = new Headers({
      "x-twilio-email-event-webhook-signature": "s",
      "x-twilio-email-event-webhook-timestamp": String(NOW / 1000),
    });
    expect(sendgridSignatureError(Buffer.from("[]"), headers, NOW)).toMatch(/^Verification raised: /u);
  });
});

describe("resend", () => {
  const secret = "whsec_dGVzdC1yZXNlbmQtc2VjcmV0";
  const sign = (body: string, id = "msg_1", stamp = String(NOW / 1000)) => ({
    "svix-id": id,
    "svix-timestamp": stamp,
    "svix-signature": `v1,${createHmac("sha256", Buffer.from("test-resend-secret")).update(`${id}.${stamp}.${body}`).digest("base64")}`,
  });

  it("checks the Svix signature and its five minute window", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
    expect(resendSignatureIsValid(Buffer.from("{}"), new Headers(sign("{}")), NOW)).toBe(true);
    expect(resendSignatureIsValid(Buffer.from("{ }"), new Headers(sign("{}")), NOW)).toBe(false);
    expect(
      resendSignatureIsValid(Buffer.from("{}"), new Headers(sign("{}", "msg_1", String(NOW / 1000 - 301))), NOW),
    ).toBe(false);
  });

  it("rejects every delivery when no secret is configured", () => {
    expect(resendSignatureIsValid(Buffer.from("{}"), new Headers(sign("{}")), NOW)).toBe(false);
  });

  describe("resendEventIsTrackable", () => {
    beforeEach(() => vi.stubEnv("MAILER_HEADERS_ENCRYPTION_KEY_V1", "test_encryption_key"));
    const header = (field: Parameters<typeof headerName>[0], value: string) => ({
      name: headerName(field),
      value: encryptHeader(value),
    });
    const event = (type: string, headers: unknown[]) => ({
      type,
      data: { created_at: "2025-01-02 00:14:11.140106+00", to: ["buyer@example.com"], headers },
    });
    const tracked = () => [header("mailer_class", "CustomerMailer"), header("mailer_method", "receipt")];

    it("keeps a tracked event type sent by our mailers", () => {
      expect(resendEventIsTrackable(event("email.delivered", tracked()))).toBe(true);
    });

    it("drops an untracked event type and mail without our headers", () => {
      expect(resendEventIsTrackable(event("email.sent", tracked()))).toBe(false);
      expect(resendEventIsTrackable(event("email.delivered", []))).toBe(false);
      expect(
        resendEventIsTrackable(
          event("email.delivered", [header("mailer_class", "CustomerMailer"), header("mailer_method", "  ")]),
        ),
      ).toBe(false);
    });

    it("keeps a payload it cannot parse so the job decides", () => {
      expect(resendEventIsTrackable({ type: "email.delivered" })).toBe(true);
      expect(
        resendEventIsTrackable(event("email.delivered", [{ name: headerName("mailer_class"), value: "v1:AAAA:BBBB" }])),
      ).toBe(true);
      expect(resendEventIsTrackable(event("email.delivered", [{ name: headerName("mailer_class"), value: 5 }]))).toBe(
        true,
      );
      expect(
        resendEventIsTrackable({ type: "email.delivered", data: { created_at: 5, to: [], headers: tracked() } }),
      ).toBe(true);
    });

    it("keeps an event whose workflow ids are not JSON only when Ruby would not read them", () => {
      expect(() =>
        resendEventIsTrackable(event("email.delivered", [...tracked(), header("workflow_ids", "{")])),
      ).toThrow(NotPortedError);
      expect(resendEventIsTrackable(event("email.delivered", [...tracked(), header("workflow_ids", "[1,2]")]))).toBe(
        true,
      );
    });
  });
});

describe("paypal", () => {
  it("rejects every webhook when no webhook id is configured", async () => {
    const headers = new Headers({
      "paypal-transmission-id": "a",
      "paypal-transmission-sig": "b",
      "paypal-cert-url": "c",
      "paypal-auth-algo": "d",
      "paypal-transmission-time": "e",
    });
    await expect(paypalWebhookIsValid({ headers, rawBody: "{}", fallbackPayload: {} })).resolves.toBe(false);
  });

  it("rejects a webhook missing a signature header before calling PayPal", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH");
    const headers = new Headers({
      "paypal-transmission-id": "a",
      "paypal-transmission-sig": " ",
      "paypal-cert-url": "c",
      "paypal-auth-algo": "d",
      "paypal-transmission-time": "e",
    });
    await expect(paypalWebhookIsValid({ headers, rawBody: "{}", fallbackPayload: {} })).resolves.toBe(false);
  });

  it("holds back every event type except order and merchant account events", () => {
    expect(paypalEventDelaySeconds("PAYMENT.CAPTURE.COMPLETED")).toBeNull();
    expect(paypalEventDelaySeconds("MERCHANT.ONBOARDING.COMPLETED")).toBeNull();
    expect(paypalEventDelaySeconds("BILLING.SUBSCRIPTION.CREATED")).toBe(600);
    expect(paypalEventDelaySeconds(undefined)).toBe(600);
  });
});
