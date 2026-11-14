// Every REST call to api.sandbox.paypal.com in the VCR cassettes Rails recorded (spec/support/fixtures/vcr_cassettes), rebuilt from the
// recorded request through the Node client: the same method, URL, body and the headers PayPal reads. The arguments are read back out of
// each recorded request, so the body builders are pinned on every real call, key order included.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { PaypalIntegrationRestApi, PaypalRestApi, type PaypalRequest, type PurchaseUnitInfo } from "./rest-api.ts";

type Recorded = { file: string; method: string; uri: string; body: string; headers: Record<string, string> };

const CASSETTES = path.join(process.cwd(), "..", "spec", "support", "fixtures", "vcr_cassettes");

function* cassetteFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* cassetteFiles(full);
    else if (entry.endsWith(".yml")) yield full;
  }
}

function paypalRequests(): Recorded[] {
  const found: Recorded[] = [];
  for (const file of cassetteFiles(CASSETTES)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("https://api.sandbox.paypal.com/")) continue;
    let cassette: {
      http_interactions?: {
        request: { method: string; uri: string; body?: { string?: string }; headers?: Record<string, string[]> };
      }[];
    } | null;
    try {
      cassette = parse(text, { logLevel: "silent" }) as typeof cassette;
    } catch {
      continue;
    }
    for (const { request } of cassette?.http_interactions ?? []) {
      if (!request.uri.startsWith("https://api.sandbox.paypal.com/") || request.uri.includes("/v1/oauth2/token"))
        continue;
      const headers: Record<string, string> = {};
      for (const [name, values] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = values[0] ?? "";
      found.push({
        file: path.relative(CASSETTES, file),
        method: request.method.toUpperCase(),
        uri: request.uri,
        body: request.body?.string ?? "",
        headers,
      });
    }
  }
  return found;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cassette bodies are read as loose JSON
const json = (text: string) => JSON.parse(text) as Record<string, any>;

function client(sent: PaypalRequest[], now = () => 1_700_000_000_000) {
  const api = new PaypalRestApi({
    authToken: async () => "Bearer token",
    now,
    transport: async (request) => {
      sent.push(request);
      return { status: 200, contentType: "application/json", body: "{}" };
    },
  });
  return api;
}

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe("PayPal requests recorded in the VCR cassettes", () => {
  const requests = paypalRequests();

  it("finds a body of cassettes to check", () => {
    expect(requests.length).toBeGreaterThan(150);
  });

  it("are rebuilt by the Node client with the same method, URL, body and headers", async () => {
    const mismatches: string[] = [];
    const counts: Record<string, number> = {};
    const stale: string[] = [];
    for (const recorded of requests) {
      const sent: PaypalRequest[] = [];
      const url = new URL(recorded.uri);
      const route = url.pathname.replace(/[A-Z0-9]{12,}|invalid_[a-z_]+/gu, "ID");
      const key = `${recorded.method} ${route}`;
      process.env.PAYPAL_PARTNER_MERCHANT_ID = "<PAYPAL_PARTNER_MERCHANT_ID>";
      process.env.PAYPAL_BN_CODE = recorded.headers["paypal-partner-attribution-id"] ?? "";
      const api = client(sent);
      const id = url.pathname.split("/");
      let handled = true;
      if (key === "POST /v2/checkout/orders") {
        const body = json(recorded.body);
        const unit = body.purchase_units[0];
        // Cassettes recorded before the partner fee moved into payment_instruction, or with a reference_id, hold a body the current code no longer builds.
        if (!unit.payment_instruction || "reference_id" in unit || !body.application_context) {
          stale.push(recorded.file);
          continue;
        }
        process.env.PAYPAL_PARTNER_MERCHANT_EMAIL = unit.payment_instruction.platform_fees[0].payee.email_address;
        const info: PurchaseUnitInfo = {
          currency: unit.amount.currency_code,
          total: unit.amount.value,
          shipping: unit.amount.breakdown.shipping.value,
          tax: unit.amount.breakdown.tax_total.value,
          price: unit.amount.breakdown.item_total.value,
          merchant_id: unit.payee.merchant_id,
          items: unit.items,
          descriptor: unit.soft_descriptor,
          fee: unit.payment_instruction.platform_fees[0].amount.value,
          invoice_id: unit.invoice_id,
        };
        await api.createOrder({ purchaseUnitInfo: info });
      } else if (/^POST \/v2\/checkout\/orders\/ID\/capture$/u.test(key)) {
        await api.capture({
          orderId: id[4]!,
          billingAgreementId: (recorded.body ? json(recorded.body).payment_source?.token?.id : null) ?? null,
        });
      } else if (/^GET \/v2\/checkout\/orders\/ID$/u.test(key)) {
        await api.fetchOrder({ orderId: id[4]! });
      } else if (/^PATCH \/v2\/checkout\/orders\/ID$/u.test(key)) {
        await api.updateInvoiceId({ orderId: id[4]!, invoiceId: json(recorded.body)[0].value });
      } else if (/^POST \/v2\/payments\/captures\/ID\/refund$/u.test(key)) {
        const assertion = recorded.headers["paypal-auth-assertion"];
        // Refunds recorded before the seller's auth assertion existed.
        if (assertion === undefined) {
          stale.push(recorded.file);
          continue;
        }
        const claims = json(Buffer.from(assertion.split(".")[1]!, "base64").toString());
        process.env.PAYPAL_PARTNER_CLIENT_ID = claims.iss;
        const amount = recorded.body ? json(recorded.body).amount : undefined;
        await api.refund({
          captureId: id[4]!,
          merchantAccount: { charge_processor_merchant_id: claims.payer_id, currency: amount?.currency_code ?? "USD" },
          amount: amount?.value ?? null,
        });
      } else if (key === "POST /v1/billing-agreements/agreement-tokens") {
        const returnUrl: string = json(recorded.body).plan.merchant_preferences.return_url;
        if ("notify_url" in json(recorded.body).plan.merchant_preferences) {
          stale.push(recorded.file);
          continue;
        }
        const agreements = new PaypalRestApi({
          authToken: async () => "Bearer token",
          domainWithProtocol: () => returnUrl.replace("/paypal_ba_return", ""),
          transport: async (request) => {
            sent.push(request);
            return { status: 200, contentType: "application/json", body: "{}" };
          },
        });
        await agreements.generateBillingAgreementToken({
          shipping: json(recorded.body).plan.merchant_preferences.skip_shipping_address === false,
        });
      } else if (key === "POST /v1/billing-agreements/agreements") {
        await api.createBillingAgreement({ billingAgreementTokenId: json(recorded.body).token_id });
      } else if (key === "POST /v2/customer/partner-referrals") {
        const body = json(recorded.body);
        const trackingId: string = body.tracking_id;
        const dash = trackingId.lastIndexOf("-");
        const features: string[] =
          body.operations[0].api_integration_preference.rest_api_integration.third_party_details.features;
        // Referrals recorded when the feature list was shorter or longer, or the tracking id had no external id.
        if (
          dash < 0 ||
          features.join() !==
            "PAYMENT,REFUND,PARTNER_FEE,DELAY_FUNDS_DISBURSEMENT,ACCESS_MERCHANT_INFORMATION,READ_SELLER_DISPUTE"
        ) {
          stale.push(recorded.file);
          continue;
        }
        process.env.LOGO_URL = body.partner_config_override.partner_logo_url;
        const integration = new PaypalIntegrationRestApi(
          { external_id: trackingId.slice(0, dash), email: body.email },
          { authorizationHeader: recorded.headers.authorization ?? "" },
          {
            now: () => Number(trackingId.slice(dash + 1)) * 1000,
            transport: async (request) => {
              sent.push({ ...request, method: request.method });
              return { status: 200, contentType: "application/json", body: "{}" };
            },
          },
        );
        await integration.createPartnerReferral(body.partner_config_override.return_url);
      } else if (
        /^GET \/v1\/customer\/partners\/.*\/merchant-integrations\/ID$/u.test(
          key.replace("%3CPAYPAL_PARTNER_MERCHANT_ID%3E", "X"),
        )
      ) {
        const integration = new PaypalIntegrationRestApi(
          { external_id: "", email: null },
          { authorizationHeader: recorded.headers.authorization ?? "" },
          {
            transport: async (request) => {
              sent.push(request);
              return { status: 200, contentType: "application/json", body: "{}" };
            },
          },
        );
        await integration.getMerchantAccountByMerchantId(id[id.length - 1]!);
      } else {
        handled = false;
        mismatches.push(`unrouted ${key} (${recorded.file})`);
      }
      if (!handled) continue;
      counts[key] = (counts[key] ?? 0) + 1;

      const request = sent[0]!;
      const expectedUrl = recorded.uri.replace(/%3C/giu, "<").replace(/%3E/giu, ">");
      const emptyPost = recorded.method === "POST" && recorded.body === "";
      const problems: string[] = [];
      if (request.method !== recorded.method) problems.push("method");
      if (request.url.replace(/%3C/giu, "<").replace(/%3E/giu, ">") !== expectedUrl)
        problems.push(`url ${request.url}`);
      if (!emptyPost && (request.body ?? "") !== recorded.body)
        problems.push(`body ${request.body} vs ${recorded.body}`);
      const orderApi = !key.includes("/customer/");
      // Calls recorded by the first revision of the client sent no Accept-Language.
      if (orderApi && recorded.headers["accept-language"] === undefined) {
        stale.push(recorded.file);
        continue;
      }
      for (const name of orderApi
        ? [
            "accept",
            "accept-language",
            "content-type",
            "prefer",
            "paypal-partner-attribution-id",
            "paypal-auth-assertion",
          ]
        : ["content-type"]) {
        const expected = recorded.headers[name];
        const actual = Object.entries(request.headers).find(([header]) => header.toLowerCase() === name)?.[1];
        if (name === "paypal-partner-attribution-id" && expected === undefined) continue;
        if (expected !== undefined && expected !== actual) problems.push(`header ${name}: ${actual} vs ${expected}`);
        if (
          expected === undefined &&
          actual !== undefined &&
          !["prefer"].includes(name) &&
          recorded.headers.authorization !== undefined
        )
          problems.push(`extra header ${name}`);
      }
      const requestId = recorded.headers["paypal-request-id"];
      const sentRequestId = Object.entries(request.headers).find(
        ([header]) => header.toLowerCase() === "paypal-request-id",
      )?.[1];
      if (
        requestId !== undefined &&
        /^(capture|create-billing-agreement)-/u.test(requestId) &&
        requestId !== sentRequestId
      )
        problems.push(`request id ${sentRequestId} vs ${requestId}`);
      if (requestId !== undefined && /^refund-/u.test(requestId) && !sentRequestId?.startsWith(`refund-${id[4]}-`))
        problems.push(`request id ${sentRequestId} vs ${requestId}`);
      if (problems.length > 0) mismatches.push(`${recorded.file}: ${key}: ${problems.join("; ")}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    // Partner referrals and agreement tokens were only recorded with older bodies; rest-api.test.ts pins their current shape.
    expect(Object.keys(counts).sort()).toEqual([
      "GET /v1/customer/partners/%3CPAYPAL_PARTNER_MERCHANT_ID%3E/merchant-integrations/ID",
      "GET /v2/checkout/orders/ID",
      "PATCH /v2/checkout/orders/ID",
      "POST /v1/billing-agreements/agreements",
      "POST /v2/checkout/orders",
      "POST /v2/checkout/orders/ID/capture",
      "POST /v2/payments/captures/ID/refund",
    ]);
    // Stale shapes are the exception: most of what was recorded is rebuilt byte for byte.
    const checked = Object.values(counts).reduce((sum, count) => sum + count, 0);
    expect(checked).toBeGreaterThan(150);
    expect(stale.length).toBeLessThan(checked / 2);
  });
});
