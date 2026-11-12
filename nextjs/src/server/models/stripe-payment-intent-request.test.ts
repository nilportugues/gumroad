// Replays __fixtures__/stripe-payment-intent-request.golden.json (scripts/golden/stripe-payment-intent-request.rb): the requests the
// real StripeChargeProcessor#create_payment_intent_or_charge! sent through WebMock, and the refusals it raised before any call.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as intent from "./stripe-payment-intent-request.ts";

type GoldenInput = {
  merchant: "platform" | "destination" | "direct";
  chargeable: {
    kind: "payment_method" | "upi";
    payment_method_id?: string | null;
    customer_id?: string | null;
    country?: string | null;
    validated_mandate_id?: string | null;
    payment_method_id_on_connect_account?: string | null;
    customer_id_on_connect_account?: string | null;
    verified?: boolean;
    authorization_currency?: string | null;
    authorization_max_cents?: number | null;
  };
  amount_cents: number;
  amount_for_gumroad_cents: number;
  reference: string;
  description: string | null;
  metadata: Record<string, string> | null;
  statement_description: string | null;
  transfer_group: string | null;
  off_session: boolean;
  setup_future_charges: boolean;
  mandate_options: intent.StripeParams | null;
  mandate_expected: boolean;
  resolved_mandate_id: string | null;
  fail_fast_without_mandate: boolean;
  processor_amount_cents: number | null;
  processor_currency: string | null;
  processor_gumroad_amount_cents: number | null;
  stripe_fx_quote_id: string | null;
  idempotency_key: string | null;
};
type GoldenRequest = { method: string; path: string; headers: Record<string, string>; body: string };
type GoldenCase = {
  input: GoldenInput;
  output: {
    requests: GoldenRequest[];
    error: { class: string; message: string; code: string | null } | null;
    mandate_lookup: string[];
    notified: number;
  };
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/stripe-payment-intent-request.golden.json"), "utf8"),
) as { cases: GoldenCase[] };

const MERCHANT_IDS = { platform: null, destination: "acct_destination", direct: "acct_direct" } as const;

function inputOf(input: GoldenInput): intent.PaymentIntentRequestInput {
  const { chargeable } = input;
  const merchant: intent.MerchantAccountKind =
    input.merchant === "platform"
      ? { kind: "platform" }
      : { kind: input.merchant, chargeProcessorMerchantId: MERCHANT_IDS[input.merchant] };
  return {
    merchant,
    chargeable:
      chargeable.kind === "upi"
        ? {
            kind: "upi",
            customerId: chargeable.customer_id ?? null,
            paymentMethodId: chargeable.payment_method_id ?? null,
            recurringAuthorizationVerified: chargeable.verified ?? false,
            recurringAuthorizationCurrency: chargeable.authorization_currency ?? null,
            recurringAuthorizationMaxAmountCents: chargeable.authorization_max_cents ?? null,
          }
        : {
            kind: "payment_method",
            paymentMethodId: chargeable.payment_method_id ?? null,
            customerId: chargeable.customer_id ?? null,
            paymentMethodIdOnConnectAccount: chargeable.payment_method_id_on_connect_account ?? null,
            customerIdOnConnectAccount: chargeable.customer_id_on_connect_account ?? null,
            country: chargeable.country ?? null,
            validatedMandateId: chargeable.validated_mandate_id ?? null,
          },
    amountCents: input.amount_cents,
    amountForGumroadCents: input.amount_for_gumroad_cents,
    reference: input.reference,
    description: input.description,
    metadata: input.metadata,
    statementDescription: input.statement_description,
    transferGroup: input.transfer_group,
    offSession: input.off_session,
    setupFutureCharges: input.setup_future_charges,
    mandateOptions: input.mandate_options,
    mandateExpected: input.mandate_expected,
    resolvedMandateId: input.resolved_mandate_id,
    failFastWithoutMandate: input.fail_fast_without_mandate,
    processorAmountCents: input.processor_amount_cents,
    processorCurrency: input.processor_currency,
    processorGumroadAmountCents: input.processor_gumroad_amount_cents,
    stripeFxQuoteId: input.stripe_fx_quote_id,
    idempotencyKey: input.idempotency_key,
  };
}

const KEY = { explicit: "<explicit>", generated: "<generated>" } as const;
const wire = (request: intent.StripeRequest): GoldenRequest => ({
  method: request.method,
  path: request.path,
  headers: { "Idempotency-Key": KEY[request.idempotencyKey], ...request.headers },
  body: request.body,
});
const sortedHeaders = (request: GoldenRequest): GoldenRequest => ({
  ...request,
  headers: Object.fromEntries(Object.entries(request.headers).sort(([a], [b]) => a.localeCompare(b))),
});

describe("PaymentIntent create and confirm requests", () => {
  it("covers every branch the golden records", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(70);
    expect(golden.cases.filter((c) => c.output.error === null).length).toBeGreaterThanOrEqual(55);
    expect(golden.cases.filter((c) => c.output.error !== null).length).toBeGreaterThanOrEqual(10);
  });

  it("sends the bodies, headers and idempotency keys Ruby sends", () => {
    for (const { input, output } of golden.cases) {
      const result = intent.buildPaymentIntentRequests(inputOf(input));
      const label = JSON.stringify(input);
      if (output.error !== null) {
        expect(result.ok, label).toBe(false);
        if (!result.ok) {
          expect(result.refusal, label).toEqual({
            className: output.error.class,
            message: output.error.message,
            code: output.error.code,
          });
          expect(result.notifications, label).toBe(output.notified);
        }
        expect(output.requests, label).toEqual([]);
        continue;
      }
      expect(result.ok, label).toBe(true);
      if (!result.ok) continue;
      expect(result.plan.notifications, label).toBe(output.notified);
      const expected = output.requests.map(sortedHeaders);
      const sent = [result.plan.create, result.plan.confirm].map((request) => sortedHeaders(wire(request)));
      expect(sent, label).toEqual(expected);
    }
  });

  it("asks for the mandate lookups Ruby makes, and only those", () => {
    for (const { input, output } of golden.cases) {
      const lookups = intent.mandateLookups(inputOf(input), input.resolved_mandate_id);
      const expected = [lookups.lookup ? "lookup" : null, lookups.pendingCheck ? "pending_check" : null].filter(
        Boolean,
      );
      // UPI Autopay and seller-proceeds refusals stop before or after the lookup depending on where Ruby raises, so the
      // lookups are compared only for the cases that reached the create.
      if (output.requests.length > 0) expect(expected, JSON.stringify(input)).toEqual(output.mandate_lookup);
    }
  });
});

describe("the statement descriptor suffix", () => {
  it("is the seller's name stripped to letters, digits, dot, slash and space, trimmed to 22 characters, or absent", () => {
    expect(intent.statementDescriptorSuffix("Jane Doe & Sons, LLC!")).toBe("Jane Doe  Sons LLC");
    expect(intent.statementDescriptorSuffix("名前")).toBeNull();
    expect(intent.statementDescriptorSuffix(null)).toBeNull();
    expect(intent.statementDescriptorSuffix("x".repeat(30))).toBe("x".repeat(22));
  });
});

describe("form encoding", () => {
  it("drops nil, keeps false, zero and the empty string, and escapes like CGI.escape", () => {
    expect(intent.encodeStripeParams({ a: null, b: false, c: 0, d: "", e: "x y&z=~*", f: { g: ["h", "i"] } })).toBe(
      "b=false&c=0&d=&e=x+y%26z%3D~%2A&f[g][0]=h&f[g][1]=i",
    );
  });
});
