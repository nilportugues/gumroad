// What Rails does for a paid POST /orders, read off purchase-paid-order.golden.json (scripts/golden/purchase-paid-order.rb): the real
// app driven through an integration session, Stripe and TaxJar answered by WebMock. This pins the outcomes a Node port of the order
// has to reproduce, above all the ambiguous ones (a lost answer, 3DS, a processing intent, a late confirmation), where a mistake would
// leave a charged card with a purchase that is not successful. Nothing here ports code; it keeps the recording from rotting and makes
// every claim in parity-debt.md checkable.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type Entry = {
  marker?: string;
  phase?: string;
  sql?: string;
  job?: string;
  args?: unknown;
  at?: number | null;
  http?: { method: string; path: string; status?: number; raised?: string; body?: string };
  flipper?: string;
  redis?: string[];
};
type Table = { fields: string[]; rows: unknown[][] };
type Case = {
  name: string;
  error: unknown;
  statements: Entry[];
  rows: Record<string, Table>;
  http: { method: string; url: string; headers: Record<string, string> }[];
  responses: Record<string, unknown>[];
};

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "__fixtures__/purchase-paid-order.golden.json"), "utf8")) as {
  now: string;
  cases: Case[];
};
const NOW_SECONDS = Date.parse(golden.now) / 1000;
// ChargeProcessor::TIME_TO_COMPLETE_SCA
const SCA_WINDOW_SECONDS = 15 * 60;

const named = (name: string) => {
  const found = golden.cases.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const calls = (c: Case) =>
  c.statements.flatMap((entry) => (entry.http ? [`${entry.http.method} ${entry.http.path}`] : []));
const jobs = (c: Case) => c.statements.flatMap((entry) => (entry.job ? [entry.job] : []));
const column = (c: Case, table: string, name: string) => {
  const t = c.rows[table];
  return t ? t.rows.map((row) => row[t.fields.indexOf(name)]) : [];
};
const keys = (c: Case, method: string, path: RegExp) =>
  c.http.filter((call) => call.method === method && path.test(call.url)).map((call) => call.headers["Idempotency-Key"]);
const PI = /\/v1\/payment_intents$/u;
const CONFIRM = /\/confirm$/u;

describe("purchase-paid-order.golden.json", () => {
  it("recorded every case without a Ruby error", () => {
    expect(golden.cases.map((c) => [c.name, c.error])).toEqual(golden.cases.map((c) => [c.name, null]));
  });

  it("calls Stripe in the order payment method, payment intent, confirm, charge for a $5 sale", () => {
    const c = named("a $5 sale");
    expect(calls(c)).toEqual([
      "GET /v1/payment_methods/pm_1SzH3vIBOqvOFDrfC0dEIUL7",
      "POST /v1/payment_intents",
      "POST /v1/payment_intents/pi_golden_1/confirm",
      "GET /v1/charges/ch_pi_golden_1",
    ]);
    expect(column(c, "purchases", "purchase_state")).toEqual(["successful"]);
    expect(jobs(c).at(-1)).toBe("SendChargeReceiptJob");
    expect(column(c, "charges", "stripe_payment_intent_id")).toEqual(["pi_golden_1"]);
  });

  describe("a lost answer", () => {
    it("retries a lost PaymentIntent create under one idempotency key and goes on when a retry answers", () => {
      const c = named("the PaymentIntent create loses its first answer");
      expect(calls(c).filter((call) => call === "POST /v1/payment_intents")).toHaveLength(2);
      expect(new Set(keys(c, "POST", PI)).size).toBe(1);
      expect(column(c, "purchases", "purchase_state")).toEqual(["successful"]);
    });

    it("fails the purchase, unpaid, when every PaymentIntent create loses its answer", () => {
      const c = named("the PaymentIntent create loses every answer");
      expect(calls(c).filter((call) => call === "POST /v1/payment_intents")).toHaveLength(4);
      expect(new Set(keys(c, "POST", PI)).size).toBe(1);
      expect(column(c, "purchases", "purchase_state")).toEqual(["failed"]);
      expect(column(c, "purchases", "error_code")).toEqual(["stripe_unavailable"]);
      expect(column(c, "processor_payment_intents", "intent_id")).toEqual([]);
      expect(jobs(c)).not.toContain("FailAbandonedPurchaseWorker");
    });

    it("retries a lost confirm under one idempotency key and goes on when a retry answers", () => {
      const c = named("the confirm loses its first answer");
      expect(calls(c).filter((call) => call.endsWith("/confirm"))).toHaveLength(2);
      expect(new Set(keys(c, "POST", CONFIRM)).size).toBe(1);
      expect(column(c, "purchases", "purchase_state")).toEqual(["successful"]);
    });

    it("fails the purchase when every confirm loses its answer, although Stripe may have charged the card", () => {
      const c = named("the confirm loses every answer");
      expect(calls(c).filter((call) => call.endsWith("/confirm"))).toHaveLength(4);
      expect(column(c, "purchases", "purchase_state")).toEqual(["failed"]);
      expect(column(c, "purchases", "error_code")).toEqual(["stripe_unavailable"]);
      // The intent id is never stored, on the charge or in processor_payment_intents: nothing in Rails can find the intent again.
      expect(column(c, "processor_payment_intents", "intent_id")).toEqual([]);
      expect(column(c, "charges", "stripe_payment_intent_id")).toEqual([null]);
      expect(jobs(c)).not.toContain("FailAbandonedPurchaseWorker");
    });
  });

  describe("an intent that is not settled", () => {
    it("leaves a requires_action purchase in progress and schedules its abandonment 15 minutes out", () => {
      const c = named("a requires_action intent");
      expect(calls(c)).toEqual([
        "GET /v1/payment_methods/pm_1SzH3vIBOqvOFDrfC0dEIUL7",
        "POST /v1/payment_intents",
        "POST /v1/payment_intents/pi_golden_1/confirm",
      ]);
      expect(column(c, "purchases", "purchase_state")).toEqual(["in_progress"]);
      expect(column(c, "processor_payment_intents", "intent_id")).toEqual(["pi_golden_1"]);
      const abandon = c.statements.find((entry) => entry.job === "FailAbandonedPurchaseWorker");
      expect(abandon?.args).toEqual([1]);
      expect(Math.round((abandon?.at ?? 0) - NOW_SECONDS)).toBe(SCA_WINDOW_SECONDS);
      expect(c.responses[0]).toMatchObject({
        line_items: {
          "uid-0": { success: true, requires_card_action: true, intent_id: "pi_golden_1", intent_type: "payment" },
        },
      });
    });

    it("answers a processing intent as processing, with the charge confirmed by the client and no abandonment job", () => {
      const c = named("a processing intent");
      expect(column(c, "purchases", "purchase_state")).toEqual(["in_progress"]);
      expect(column(c, "purchases", "stripe_status")).toEqual(["processing"]);
      // charges.flags bit 2 is client_confirmed
      expect(column(c, "charges", "flags")).toEqual([2]);
      expect(jobs(c)).not.toContain("FailAbandonedPurchaseWorker");
      expect(c.responses[0]).toMatchObject({
        line_items: { "uid-0": { success: true, processing: true, permalink: "paidone" } },
      });
    });

    it("finishes a requires_action purchase from the late confirmation by reading the intent, not confirming it again", () => {
      const c = named("a requires_action intent confirmed late");
      expect(calls(c).slice(3)).toEqual(["GET /v1/payment_intents/pi_golden_1", "GET /v1/charges/ch_pi_golden_1"]);
      expect(column(c, "purchases", "purchase_state")).toEqual(["successful"]);
      expect(jobs(c).at(-1)).toBe("SendChargeReceiptJob");
    });

    it("fails the purchase when the late confirmation finds the card was not charged", () => {
      const c = named("a requires_action intent confirmed late, the card fails");
      expect(calls(c).slice(3)).toEqual([
        "GET /v1/payment_intents/pi_golden_1",
        "POST /v1/payment_intents/pi_golden_1/confirm",
      ]);
      expect(column(c, "purchases", "purchase_state")).toEqual(["failed"]);
    });
  });

  describe("a taxed, tipped, discounted or multi-line order", () => {
    const taxJar = (c: Case) =>
      c.statements.flatMap((entry) => (entry.http?.path === "/v2/taxes" ? [entry.http.status] : []));

    it("asks TaxJar before Stripe and charges the price plus the tax it answered", () => {
      const c = named("a taxed order (TaxJar answers)");
      expect(calls(c)[0]).toBe("POST /v2/taxes");
      expect(taxJar(c)).toEqual([200]);
      expect(column(c, "purchases", "gumroad_tax_cents")).toEqual([51]);
      expect(column(c, "purchases", "total_transaction_cents")).toEqual([551]);
      expect(column(c, "charges", "amount_cents")).toEqual([551]);
      expect(column(c, "purchase_taxjar_infos", "purchase_id")).toEqual([1]);
    });

    it("charges the price with no tax when TaxJar is down, and the purchase still succeeds", () => {
      const c = named("a taxed order (TaxJar is down)");
      expect(taxJar(c)).toEqual([503]);
      expect(column(c, "purchases", "gumroad_tax_cents")).toEqual([0]);
      expect(column(c, "charges", "amount_cents")).toEqual([500]);
      expect(column(c, "purchases", "purchase_state")).toEqual(["successful"]);
    });

    it("adds the tip to the price and to the fee base", () => {
      const c = named("a tipped order");
      expect(column(c, "purchases", "price_cents")).toEqual([600]);
      expect(column(c, "purchases", "fee_cents")).toEqual([157]);
      expect(column(c, "charges", "amount_cents")).toEqual([600]);
    });

    it("charges the discounted price and keeps the offer code on the purchase", () => {
      const c = named("a discounted order");
      expect(column(c, "purchases", "price_cents")).toEqual([250]);
      expect(column(c, "purchases", "offer_code_id")).toEqual([1]);
      expect(column(c, "charges", "amount_cents")).toEqual([250]);
    });

    it("charges two lines of one seller as one charge, one intent and one TaxJar call per line", () => {
      const c = named("a multi-line order, taxed, tipped and discounted");
      expect(column(c, "purchases", "total_transaction_cents")).toEqual([301, 1151]);
      expect(column(c, "charges", "amount_cents")).toEqual([1452]);
      expect(column(c, "charge_purchases", "purchase_id")).toEqual([1, 2]);
      expect(taxJar(c)).toEqual([200, 200]);
      expect(calls(c).filter((call) => call === "POST /v1/payment_intents")).toHaveLength(1);
      expect(Object.keys(c.responses[0]!.line_items)).toEqual(["uid-0", "uid-1"]);
    });
  });

  describe("a decline", () => {
    it("fails the purchase and writes no balance", () => {
      const c = named("a declined card");
      expect(calls(c)).toHaveLength(3);
      expect(column(c, "purchases", "purchase_state")).toEqual(["failed"]);
      expect(c.rows.balances).toBeUndefined();
    });

    it("also adds the card to Radar's value list for a fraudulent decline, and for no other reason", () => {
      expect(jobs(named("a declined card, fraudulent"))).toContain("Radar::AddValueListItemJob");
      for (const other of ["a declined card", "a declined card, incorrect zip", "a declined card, insufficient funds"])
        expect(jobs(named(other))).not.toContain("Radar::AddValueListItemJob");
    });
  });
});
