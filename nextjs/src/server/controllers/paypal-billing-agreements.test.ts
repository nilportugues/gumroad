// Vectors follow spec/requests/paypal_billing_agreements_parity_spec.rb and spec/controllers/paypal_controller_spec.rb.
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaypalRestApi, type PaypalRequest } from "../paypal/rest-api.ts";

import { HandBackToRails } from "./application-controller.ts";

vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

const { billingAgreement, billingAgreementToken, setPaypalRestApiForTesting } = await import(
  "./paypal-billing-agreements.ts"
);

type Answer = { status: number; contentType?: string; body: string } | Error;

function stubPayPal(answer: Answer): PaypalRequest[] {
  const sent: PaypalRequest[] = [];
  setPaypalRestApiForTesting(
    () =>
      new PaypalRestApi({
        authToken: async () => "Bearer partner",
        domainWithProtocol: () => "https://gumroad.example.com",
        transport: async (request) => {
          sent.push(request);
          if (answer instanceof Error) throw answer;
          return { status: answer.status, contentType: answer.contentType ?? "application/json", body: answer.body };
        },
      }),
  );
  return sent;
}

const body = (result: unknown) => (result as { body: string }).body;

afterEach(() => setPaypalRestApiForTesting(null));

describe("PaypalController#billing_agreement_token", () => {
  it("renders the token id PayPal issued and asks for no shipping address by default", async () => {
    const sent = stubPayPal({ status: 201, body: '{"token_id":"BA-7TR16712TA5219609","links":[]}' });

    const result = await billingAgreementToken({ params: {} });

    expect(body(result)).toBe('{"billing_agreement_token_id":"BA-7TR16712TA5219609"}');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/v1\/billing-agreements\/agreement-tokens$/u);
    expect(JSON.parse(sent[0]!.body!).plan.merchant_preferences.skip_shipping_address).toBe(true);
  });

  it("asks for a shipping address only when shipping is the string true", async () => {
    const sent = stubPayPal({ status: 201, body: '{"token_id":"BA-1"}' });

    await billingAgreementToken({ params: { shipping: "true" } });
    await billingAgreementToken({ params: { shipping: true } });

    const skips = sent.map((request) => JSON.parse(request.body!).plan.merchant_preferences.skip_shipping_address);
    expect(skips).toEqual([false, true]);
  });

  it.each([
    ["a refusal", { status: 400, body: '{"name":"VALIDATION_ERROR"}' }],
    ["a success without a token", { status: 201, body: '{"links":[]}' }],
    ["a blank token", { status: 201, body: '{"token_id":"  "}' }],
    ["a body that is not an object", { status: 201, body: "[]" }],
    ["a body that is not JSON", { status: 201, contentType: "text/plain", body: "BA-1" }],
  ] satisfies [string, Answer][])("renders a null token id for %s", async (_name, answer) => {
    stubPayPal(answer);

    expect(body(await billingAgreementToken({ params: {} }))).toBe('{"billing_agreement_token_id":null}');
  });

  it("hands back when PayPal could not be reached", async () => {
    stubPayPal(new Error("socket hang up"));

    await expect(billingAgreementToken({ params: {} })).rejects.toThrow(HandBackToRails);
  });
});

describe("PaypalController#billing_agreement", () => {
  it("renders the agreement PayPal created, keeping its key order", async () => {
    const sent = stubPayPal({
      status: 201,
      body: '{"id":"B-1","state":"ACTIVE","payer":{"payer_info":{"email":"a@example.com"}},"links":[{"rel":"self"}]}',
    });

    const result = await billingAgreement({ params: { billing_agreement_token_id: "BA-1" } });

    expect(body(result)).toBe(
      '{"id":"B-1","state":"ACTIVE","payer":{"payer_info":{"email":"a@example.com"}},"links":[{"rel":"self"}]}',
    );
    expect(sent[0]!.url).toMatch(/\/v1\/billing-agreements\/agreements$/u);
    expect(sent[0]!.headers["PayPal-Request-Id"]).toBe("create-billing-agreement-BA-1");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ token_id: "BA-1" });
  });

  it.each([
    ["a refusal", { status: 400, body: '{"name":"VALIDATION_ERROR"}' }],
    ["a success without an id", { status: 201, body: '{"state":"ACTIVE"}' }],
    ["a body that is not an object", { status: 201, contentType: "text/plain", body: "ok" }],
  ] satisfies [string, Answer][])("renders null for %s", async (_name, answer) => {
    stubPayPal(answer);

    expect(body(await billingAgreement({ params: { billing_agreement_token_id: "BA-1" } }))).toBe("null");
  });

  it.each([[undefined], [["BA-1"]], [{ a: "b" }]])(
    "hands back a token id of %j before calling PayPal",
    async (value) => {
      const sent = stubPayPal({ status: 201, body: '{"id":"B-1"}' });

      await expect(billingAgreement({ params: { billing_agreement_token_id: value } })).rejects.toThrow(
        HandBackToRails,
      );
      expect(sent).toEqual([]);
    },
  );

  it("hands back an answer with a fractional number, which Ruby would print differently", async () => {
    stubPayPal({ status: 201, body: '{"id":"B-1","amount":1.5}' });

    await expect(billingAgreement({ params: { billing_agreement_token_id: "BA-1" } })).rejects.toThrow(HandBackToRails);
  });

  it("hands back when PayPal could not be reached", async () => {
    stubPayPal(new Error("socket hang up"));

    await expect(billingAgreement({ params: { billing_agreement_token_id: "BA-1" } })).rejects.toThrow(HandBackToRails);
  });
});
