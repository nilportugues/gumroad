// What createPaymentIntentOrCharge does beyond the recorded replays of charge-create-service.test.ts: the shapes it refuses before
// its first call, and the one it must not throw for after the intent exists.
import { describe, expect, it } from "vitest";

import { StripeClient, type TransportRequest } from "../stripe/client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "../stripe/config.ts";

import { createPaymentIntentOrCharge } from "./stripe-payment-intent-create.ts";
import type { PaymentIntentRequestInput } from "./stripe-payment-intent-request.ts";
import { NotPortedError } from "./user.ts";

const input = (change: Partial<PaymentIntentRequestInput> = {}): PaymentIntentRequestInput => ({
  merchant: { kind: "platform" },
  chargeable: {
    kind: "payment_method",
    paymentMethodId: "pm_1",
    customerId: null,
    paymentMethodIdOnConnectAccount: null,
    customerIdOnConnectAccount: null,
    country: "US",
    validatedMandateId: null,
  },
  amountCents: 500,
  amountForGumroadCents: 145,
  reference: "CH-x",
  description: "Gumroad Charge x",
  metadata: { "purchases{0}": "x" },
  statementDescription: null,
  transferGroup: "CH-1",
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
  ...change,
});

function stripe(answers: Record<string, unknown>) {
  const sent: TransportRequest[] = [];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
    transport: (request) => {
      sent.push(request);
      const key = `${request.method} ${new URL(request.url).pathname}`;
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(answers[key]) });
    },
  });
  return { client, sent };
}

describe("createPaymentIntentOrCharge", () => {
  it.each([
    ["a seller's own Stripe account", { merchant: { kind: "direct", chargeProcessorMerchantId: "acct_1" } }],
    ["a destination charge", { merchant: { kind: "destination", chargeProcessorMerchantId: "acct_1" } }],
    ["an Indian card", { chargeable: { ...input().chargeable, country: "IN" } }],
    ["an off-session charge", { offSession: true }],
    ["a buyer-currency quote", { stripeFxQuoteId: "fxq_1" }],
    ["an explicit idempotency key", { idempotencyKey: "key" }],
  ] as [string, Partial<PaymentIntentRequestInput>][])("refuses %s before any call", async (_name, change) => {
    const { client, sent } = stripe({});
    await expect(createPaymentIntentOrCharge(input(change), { client, now: new Date(0) })).rejects.toBeInstanceOf(
      NotPortedError,
    );
    expect(sent).toEqual([]);
  });

  it("returns a succeeded intent whose balance transaction was not expanded instead of throwing after the charge", async () => {
    const { client, sent } = stripe({
      "POST /v1/payment_intents": { id: "pi_1", status: "requires_confirmation", client_secret: "s" },
      "POST /v1/payment_intents/pi_1/confirm": { id: "pi_1", status: "succeeded", latest_charge: "ch_1" },
      "GET /v1/charges/ch_1": {
        id: "ch_1",
        status: "succeeded",
        balance_transaction: "txn_1",
        payment_method_details: null,
      },
    });
    const intent = await createPaymentIntentOrCharge(input(), { client, now: new Date(0) });
    expect(sent).toHaveLength(3);
    expect(intent).toMatchObject({
      id: "pi_1",
      outcome: "succeeded",
      charge: null,
      chargeUnreadable: "balance_transaction not expanded",
    });
  });

  it("does not confirm an intent that is not requires_confirmation", async () => {
    const { client, sent } = stripe({ "POST /v1/payment_intents": { id: "pi_1", status: "requires_payment_method" } });
    const intent = await createPaymentIntentOrCharge(input(), { client, now: new Date(0) });
    expect(sent).toHaveLength(1);
    expect(intent.outcome).toBe("other");
  });
});
