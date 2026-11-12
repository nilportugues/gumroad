// The PaymentIntent requests Rails sent for the recorded $5 card purchase (spec/requests/orders_paid_purchase_parity_spec.rb, Stripe
// answered by VCR cassettes), against what stripe-payment-intent-request.ts builds from the same facts.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as intent from "./stripe-payment-intent-request.ts";

const DIR = path.join(import.meta.dirname, "../../../parity/fixtures/requests/orders_paid_purchase_parity_spec");
const NAMES = [
  "hands-a-paid-tokenized-card-purchase-back-whole",
  "hands-a-signed-in-buyer-s-paid-purchase-back-whole",
  "hands-a-declined-card-purchase-back-whole",
];

type Call = { method: string; url: string; body?: string; headers: Record<string, string> };

describe("the recorded $5 card purchase", () => {
  it.each(NAMES)("%s sends the PaymentIntent create and confirm Rails recorded", (name) => {
    const fixture = JSON.parse(readFileSync(path.join(DIR, `orders-paid-purchase-${name}.json`), "utf8")) as {
      exchanges: { http: Call[] }[];
    };
    const calls = fixture.exchanges.at(-1)!.http;
    const create = calls.find(
      (call) => call.method === "POST" && new URL(call.url).pathname === "/v1/payment_intents",
    )!;
    const confirm = calls.find((call) => call.url.endsWith("/confirm"))!;
    // Stripe's bodies keep literal brackets and braces in keys; read them back without URLSearchParams' key decoding.
    const fields = new Map(
      create.body!.split("&").map((pair) => {
        const [key, value] = pair.split("=");
        return [decodeURIComponent(key!), decodeURIComponent(value!.replaceAll("+", " "))] as const;
      }),
    );

    const result = intent.buildPaymentIntentRequests({
      merchant: { kind: "platform" },
      chargeable: {
        kind: "payment_method",
        paymentMethodId: fields.get("payment_method")!,
        customerId: null,
        paymentMethodIdOnConnectAccount: null,
        customerIdOnConnectAccount: null,
        country: "US",
        validatedMandateId: null,
      },
      amountCents: Number(fields.get("amount")),
      amountForGumroadCents: 145,
      reference: "unused",
      description: fields.get("description")!,
      metadata: { "purchases{0}": fields.get("metadata[purchases{0}]")! },
      // The recorded suffix is already the sanitized seller name.
      statementDescription: fields.get("statement_descriptor_suffix")!,
      transferGroup: fields.get("transfer_group")!,
      offSession: false,
      setupFutureCharges: false,
      mandateOptions: null,
      mandateExpected: false,
      resolvedMandateId: null,
      failFastWithoutMandate: false,
      processorAmountCents: null,
      processorCurrency: null,
      processorGumroadAmountCents: null,
      stripeFxQuoteId: null,
      idempotencyKey: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.create.body).toBe(create.body);
    expect(result.plan.create.path).toBe(new URL(create.url).pathname);
    // The recorder keeps only the gem's per-attempt key, hashed to "<uuid>"; the builder says a fresh one is needed on both POSTs.
    expect(create.headers["idempotency-key"]).toBe("<uuid>");
    expect(result.plan.create.idempotencyKey).toBe("generated");
    expect(confirm.headers["idempotency-key"]).toBe("<uuid>");
    expect(result.plan.confirm.idempotencyKey).toBe("generated");
    expect(result.plan.confirm.path.replace("pi_ID", "")).toBe(new URL(confirm.url).pathname.replace(/pi_\w+/u, ""));
    expect(confirm.body ?? "").toBe(result.plan.confirm.body);
  });
});
