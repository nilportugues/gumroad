import { describe, expect, it } from "vitest";

import { usdCentsToCurrency } from "../models/concerns/currency-helper.ts";
import { NotPortedError } from "../models/user.ts";
import { debitStripeAccountForRefundFee, type RefundFeeCredit } from "./refund-fee-collection.ts";
import { ACCOUNT_ID, GOLDEN, refundFor, scriptedStripe, withRefundId, type CollectionCase, type Event } from "./refund-fee-golden.ts";

const nowSeconds = () => Date.parse(GOLDEN.now) / 1000;
const rated = (currency: string, cents: number) =>
  usdCentsToCurrency(currency, cents, currency === "usd" ? undefined : Number(GOLDEN.rates[currency.toUpperCase()]));

async function run(entry: CollectionCase) {
  const events: Event[] = [];
  const refund = refundFor(entry.input.refund, events, entry.input.on_lock);
  const credit: RefundFeeCredit = {
    amountCents: entry.input.credit_amount_cents,
    merchantAccount: { chargeProcessorMerchantId: ACCOUNT_ID, holderOfFunds: entry.input.holder_of_funds, ...entry.input.account },
    refund,
    internalTransferIds: async () => entry.input.internal_transfer_ids,
  };
  const outcome = await debitStripeAccountForRefundFee(
    { stripe: scriptedStripe(entry.answers, events), nowSeconds, platformAccountId: null, usdCentsToCurrency: rated },
    credit,
    entry.input.collect,
  ).then(
    (returned) => ({ returned: returned ?? null }),
    (error: Error & { rubyClass?: string }) => ({ raised: error.rubyClass ?? error.name, message: error.message }),
  );
  return { events, outcome, refund: refund.snapshot() };
}

describe("debitStripeAccountForRefundFee against the Ruby golden", () => {
  it("covers the branches the golden was written for", () => {
    expect(GOLDEN.collection.length).toBeGreaterThanOrEqual(33);
    expect(GOLDEN.collection.filter((entry) => entry.outcome.raised).length).toBeGreaterThanOrEqual(8);
    expect(GOLDEN.collection.filter((entry) => entry.input.on_lock).length).toBe(3);
  });

  for (const entry of GOLDEN.collection) {
    it(`makes the calls and writes of ${entry.name}`, async () => {
      const actual = await run(entry);
      expect(actual.events).toEqual(withRefundId(entry.events));
      expect(actual.outcome).toEqual(entry.outcome);
      const { fee_retention_pending: _pending, ...expectedRefund } = entry.refund;
      expect(actual.refund).toEqual(expectedRefund);
    });
  }

  // Stripe pages a list of reversals with further calls the golden has no script for; the port refuses rather than guess.
  it("refuses a list of reversals that has another page", async () => {
    const events: Event[] = [];
    const refund = refundFor({ fee_retention_source_transfer: "tr_pin" }, events);
    const credit: RefundFeeCredit = {
      amountCents: -59,
      merchantAccount: { chargeProcessorMerchantId: ACCOUNT_ID, holderOfFunds: "stripe", country: "CA", currency: "cad" },
      refund,
      internalTransferIds: async () => [],
    };
    const stripe = scriptedStripe(
      {
        "Transfer.retrieve": [{ id: "tr_pin", amount: 5000, amount_reversed: 0, currency: "usd" }],
        "Transfer.list_reversals": [{ data: [], has_more: true }],
      },
      events,
    );
    await expect(
      debitStripeAccountForRefundFee({ stripe, nowSeconds, platformAccountId: null, usdCentsToCurrency: rated }, credit),
    ).rejects.toBeInstanceOf(NotPortedError);
  });
});
