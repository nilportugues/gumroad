// StripeChargeablePaymentMethod against the paid-order golden: the one GET it makes, and the card facts Rails stored on the purchase
// (the `UPDATE purchases` that follows it) read back from the same payment method.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { ChargeProcessorUnavailableError } from "../stripe/charge-processor-errors.ts";
import { NetworkError, StripeClient, type TransportRequest } from "../stripe/client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "../stripe/config.ts";

import { buildVisual, StripeChargeablePaymentMethod } from "./stripe-chargeable-payment-method.ts";
import { NotPortedError } from "./user.ts";

type Statement = { sql?: string; http?: { method: string; path: string } };
const golden = parseRubyJson(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/purchase-paid-order.golden.json"), "utf8"),
) as unknown as { cases: { name: string; statements: Statement[] }[] };
const sale = golden.cases.find((c) => c.name === "a $5 sale")!;
const paymentMethod = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "../../../scripts/golden/support/stripe_paid_order/payment_method_get.json"),
    "utf8",
  ),
) as Record<string, unknown> & { id: string };

const clientAnswering = (body: unknown, sent: TransportRequest[] = []) =>
  new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
    sleep: () => Promise.resolve(),
    transport: (request) => {
      sent.push(request);
      if (body instanceof Error) throw body;
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    },
  });

describe("StripeChargeablePaymentMethod", () => {
  it("makes the one GET of the payment method the golden recorded", async () => {
    const sent: TransportRequest[] = [];
    await StripeChargeablePaymentMethod.prepare(
      { paymentMethodId: paymentMethod.id, isStripeConnect: false },
      { client: clientAnswering(paymentMethod, sent) },
    );
    const recorded = sale.statements.flatMap((s) => (s.http?.path.startsWith("/v1/payment_methods") ? [s.http] : []));
    expect(recorded).toHaveLength(1);
    expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `${recorded[0]!.method} ${recorded[0]!.path}`,
    ]);
  });

  it("reads the card facts Rails stored on the purchase", async () => {
    const chargeable = await StripeChargeablePaymentMethod.prepare(
      { paymentMethodId: paymentMethod.id, isStripeConnect: false },
      { client: clientAnswering(paymentMethod) },
    );
    const update = sale.statements.find((s) =>
      s.sql?.startsWith("UPDATE `purchases` SET `purchases`.`fee_cents`"),
    )!.sql!;
    const stored = (name: string) =>
      new RegExp(`\`purchases\`\\.\`${name}\` = ('([^']*)'|\\d+)`, "u").exec(update)!.slice(1);
    expect(chargeable.fingerprint).toBe(stored("stripe_fingerprint")[1]);
    expect(chargeable.cardType).toBe(stored("card_type")[1]);
    expect(chargeable.visual).toBe(stored("card_visual")[1]);
    expect(chargeable.country).toBe(stored("card_country")[1]);
    expect(chargeable.expiryMonth).toBe(Number(stored("card_expiry_month")[0]));
    expect(chargeable.expiryYear).toBe(Number(stored("card_expiry_year")[0]));
    expect(chargeable.requiresMandate).toBe(false);
    expect(chargeable.toIntentChargeable()).toMatchObject({
      paymentMethodId: paymentMethod.id,
      customerId: null,
      country: "US",
    });
  });

  it("takes the customer from the payment method unless one is given", async () => {
    const withCustomer = { ...paymentMethod, customer: "cus_1" };
    const client = clientAnswering(withCustomer);
    const fromMethod = await StripeChargeablePaymentMethod.prepare(
      { paymentMethodId: "pm_1", isStripeConnect: false },
      { client },
    );
    const given = await StripeChargeablePaymentMethod.prepare(
      { paymentMethodId: "pm_1", customerId: "cus_given", isStripeConnect: false },
      { client },
    );
    expect([fromMethod.customerId, given.customerId]).toEqual(["cus_1", "cus_given"]);
  });

  it("leaves the card type of a method with no card to the method's own type", async () => {
    const pix = { ...paymentMethod, type: "pix", card: undefined };
    const chargeable = await StripeChargeablePaymentMethod.prepare(
      { paymentMethodId: "pm_1", isStripeConnect: false },
      { client: clientAnswering(pix) },
    );
    expect([chargeable.fingerprint, chargeable.last4, chargeable.visual, chargeable.cardType]).toEqual([
      null,
      null,
      null,
      "pix",
    ]);
  });

  it("raises the processor error of a lost answer, as the error handler maps it", async () => {
    await expect(
      StripeChargeablePaymentMethod.prepare(
        { paymentMethodId: "pm_1", isStripeConnect: false },
        { client: clientAnswering(new NetworkError("read_timeout", "Net::ReadTimeout")) },
      ),
    ).rejects.toBeInstanceOf(ChargeProcessorUnavailableError);
  });

  it("refuses a Stripe Connect seller before any call", async () => {
    const sent: TransportRequest[] = [];
    await expect(
      StripeChargeablePaymentMethod.prepare(
        { paymentMethodId: "pm_1", isStripeConnect: true },
        { client: clientAnswering({}, sent) },
      ),
    ).rejects.toBeInstanceOf(NotPortedError);
    expect(sent).toEqual([]);
  });
});

describe("buildVisual", () => {
  it.each([
    ["4242", 16, "**** **** **** 4242"],
    ["0005", 15, "**** ****** *0005"],
    ["5904", 14, "**** ****** 5904"],
    ["42", 16, "**** **** **** **42"],
  ])("formats %s for a %i digit card as %s", (last4, length, expected) => {
    expect(buildVisual(last4, length)).toBe(expected);
  });
});
