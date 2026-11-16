import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadFixture } from "../src/fixture";
import { timelineSegments } from "../src/stand-in";

// The order Rails takes for a paid single-product card purchase, read off the timeline of
// spec/requests/orders_paid_purchase_parity_spec.rb (Stripe answered by copies of the OrdersController VCR cassettes). A port that
// serves this shape has to keep exactly this order; until it does, the replay hands the request back whole.
const DIR = path.join("parity/fixtures/requests", "orders_paid_purchase_parity_spec");
const PAID = "hands-a-paid-tokenized-card-purchase-back-whole";
const SIGNED_IN = "hands-a-signed-in-buyer-s-paid-purchase-back-whole";
const DECLINED = "hands-a-declined-card-purchase-back-whole";

const exchangeOf = (name: string) => loadFixture(path.join(DIR, `orders-paid-purchase-${name}.json`)).exchanges.at(-1)!;

const PRE_CHARGE_WRITES = [
  "charge_purchases",
  "charges",
  "links",
  "order_purchases",
  "orders",
  "purchase_refund_policies",
  "purchase_sales_tax_infos",
  "purchases",
];

const callsOf = (name: string) =>
  exchangeOf(name).http.map((call) => `${call.method} ${new URL(call.url).pathname.replace(/pi_\w+/u, "pi_")}`);

describe("paid purchase timeline", () => {
  it.each([PAID, SIGNED_IN, DECLINED])(
    "%s writes the purchase, order and charge rows before the first call",
    (name) => {
      expect(timelineSegments(exchangeOf(name).timeline ?? [])[0]).toEqual(PRE_CHARGE_WRITES);
    },
  );

  it("calls the processor in the order payment method, payment intent, confirm, charge", () => {
    const calls = callsOf(PAID);
    expect(calls[0]).toMatch(/^GET \/v1\/payment_methods\/pm_/u);
    expect(calls.slice(1, 3)).toEqual(["POST /v1/payment_intents", "POST /v1/payment_intents/pi_/confirm"]);
    expect(calls[3]).toMatch(/^GET \/v1\/charges\/ch_/u);
    expect(calls).toHaveLength(4);
  });

  it("stamps the charge and the purchase between the payment method read and the payment intent", () => {
    const segments = timelineSegments(exchangeOf(PAID).timeline ?? []);
    expect(segments[1]).toEqual(["charges", "purchases"]);
    expect(segments[2]).toEqual([]);
    expect(segments[3]).toEqual([]);
    expect(segments[4]).toEqual([
      "balance_transactions",
      "balances",
      "charges",
      "events",
      "processor_payment_intents",
      "purchases",
      "url_redirects",
    ]);
  });

  it("gives every write call a random idempotency key and no read one", () => {
    for (const call of exchangeOf(PAID).http)
      expect(call.headers?.["idempotency-key"], `${call.method} ${call.url}`).toBe(
        call.method === "POST" ? "<uuid>" : undefined,
      );
  });

  it("settles a declined card with no balance written", () => {
    const exchange = exchangeOf(DECLINED);
    expect(exchange.http.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
    expect(Object.keys(exchange.db)).not.toContain("balances");
    expect(timelineSegments(exchange.timeline ?? []).at(-1)).toEqual(["events", "links", "purchases"]);
  });
});
