import { afterEach, describe, expect, it } from "vitest";

import { PaypalIntegrationRestApi, PaypalRestApi, type PaypalRequest } from "./rest-api.ts";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

function transportFor(sent: PaypalRequest[], reply: { status: number; contentType?: string; body: string }) {
  return async (request: PaypalRequest) => {
    sent.push(request);
    return { status: reply.status, contentType: reply.contentType ?? "application/json", body: reply.body };
  };
}

describe("PaypalRestApi", () => {
  it("returns a failed call as its status and parsed body instead of raising", async () => {
    const sent: PaypalRequest[] = [];
    const api = new PaypalRestApi({
      authToken: async () => "Bearer t",
      transport: transportFor(sent, { status: 422, body: '{"name":"UNPROCESSABLE_ENTITY"}' }),
    });
    const response = await api.capture({ orderId: "ORDER", billingAgreementId: null });
    expect(response).toEqual({ statusCode: 422, result: { name: "UNPROCESSABLE_ENTITY" } });
    expect(api.successfulResponse(response)).toBe(false);
    expect(sent[0]!.body).toBe("{}");
    expect(sent[0]!.headers["PayPal-Request-Id"]).toBe("capture-ORDER");
  });

  it("reads the PayPal account and currency from the original order when the merchant account lacks them", async () => {
    process.env.PAYPAL_PARTNER_CLIENT_ID = "client";
    const sent: PaypalRequest[] = [];
    const api = new PaypalRestApi({
      authToken: async () => "Bearer t",
      now: () => 1_000,
      transport: transportFor(sent, { status: 201, body: "{}" }),
    });
    await api.refund({
      captureId: "CAP",
      merchantAccount: { charge_processor_merchant_id: null, currency: null },
      amount: "2.50",
      orderForCapture: async () => ({
        purchase_units: [{ payee: { merchant_id: "SELLER" }, amount: { currency_code: "gbp" } }],
      }),
    });
    expect(sent[0]!.body).toBe('{"amount":{"currency_code":"GBP","value":"2.50"}}');
    expect(sent[0]!.headers["PayPal-Request-Id"]).toBe("refund-CAP-2.50-1");
    const claims = JSON.parse(
      Buffer.from(sent[0]!.headers["Paypal-Auth-Assertion"]!.split(".")[1]!, "base64").toString(),
    ) as unknown;
    expect(claims).toEqual({ payer_id: "SELLER", iss: "client" });
  });

  it("sends a full refund with an empty body", async () => {
    const sent: PaypalRequest[] = [];
    const api = new PaypalRestApi({
      authToken: async () => "Bearer t",
      transport: transportFor(sent, { status: 201, body: "{}" }),
    });
    await api.refund({ captureId: "CAP", merchantAccount: { charge_processor_merchant_id: "S", currency: "usd" } });
    expect(sent[0]!.body).toBe("{}");
  });

  it("builds the billing agreement token request with the return URLs of the domain", async () => {
    const sent: PaypalRequest[] = [];
    const api = new PaypalRestApi({
      authToken: async () => "Bearer t",
      domainWithProtocol: () => "https://example.com",
      transport: transportFor(sent, { status: 201, body: "{}" }),
    });
    await api.generateBillingAgreementToken({ shipping: true });
    expect(sent[0]!.body).toBe(
      '{"payer":{"payment_method":"PAYPAL"},"plan":{"type":"CHANNEL_INITIATED_BILLING","merchant_preferences":{"return_url":"https://example.com/paypal_ba_return","cancel_url":"https://example.com/paypal_ba_cancel","accepted_pymt_type":"INSTANT","skip_shipping_address":false}}}',
    );
  });
});

describe("PaypalIntegrationRestApi", () => {
  it("creates a partner referral with the current feature list", async () => {
    process.env.LOGO_URL = "https://example.com/logo.png";
    const sent: PaypalRequest[] = [];
    const api = new PaypalIntegrationRestApi(
      { external_id: "ext", email: "seller@example.com" },
      { authorizationHeader: "Bearer t" },
      { now: () => 1_600_000_000_000, transport: transportFor(sent, { status: 201, body: '{"links":[]}' }) },
    );
    const response = await api.createPartnerReferral("https://example.com/return");
    expect(response).toEqual({ statusCode: 201, result: { links: [] } });
    expect(sent[0]!.url).toBe("https://api.sandbox.paypal.com/v2/customer/partner-referrals");
    expect(sent[0]!.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer t" });
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      tracking_id: "ext-1600000000",
      email: "seller@example.com",
      partner_config_override: {
        return_url: "https://example.com/return",
        partner_logo_url: "https://example.com/logo.png",
      },
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: {
                features: [
                  "PAYMENT",
                  "REFUND",
                  "PARTNER_FEE",
                  "DELAY_FUNDS_DISBURSEMENT",
                  "ACCESS_MERCHANT_INFORMATION",
                  "READ_SELLER_DISPUTE",
                ],
              },
            },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    });
  });
});
