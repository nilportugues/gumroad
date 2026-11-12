import { describe, expect, it } from "vitest";

import { ACCOUNT_ID, GOLDEN, REFUND_ID, scriptedStripe, type Answers, type Event, type Outcome } from "./refund-fee-golden.ts";
import {
  reverseExcessAmountFromStripeTransfer,
  reverseTheTransferMadeForDisputeWin,
  type DisputeWinContext,
  type ExcessContext,
} from "./refund-transfer-reversals.ts";

type Golden = {
  excess: {
    name: string;
    input: {
      transfer: { amount: number; currency?: string; amount_reversed?: number };
      balance_transaction: { issued: number; holding_currency: string; holding: number } | null;
      prior_tax_cents: number;
      gumroad_held: boolean;
    };
    answers: Answers;
    events: Event[];
    outcome: Outcome;
    credit: { amount_cents: number; balance_transaction: { holding_amount_net_cents: number } } | null;
  }[];
  dispute: {
    name: string;
    input: {
      purchases: { price: number; total: number; tax?: number }[];
      refunded: boolean[];
      refunds?: { total: number; tax: number; gumroad_funded?: boolean }[];
      unwon?: boolean;
      gumroad_held?: boolean;
    };
    answers: Answers;
    events: Event[];
    outcome: Outcome;
  }[];
};
const golden = GOLDEN as unknown as Golden;

const WON_AT_SECONDS = Date.UTC(2026, 9, 20) / 1000;
const PROCESSOR_REFUND_ID = "re_golden01";

const outcomeOf = (run: () => Promise<unknown>) =>
  run().then(
    () => ({}) as Outcome,
    (error: Error & { rubyClass?: string }) => ({ raised: error.rubyClass ?? error.name, message: error.message }) as Outcome,
  );

describe("reverseExcessAmountFromStripeTransfer against the Ruby golden", () => {
  it("covers the transfers and refusals the golden was written for", () => {
    expect(golden.excess.length).toBeGreaterThanOrEqual(16);
    expect(golden.excess.filter((entry) => entry.credit !== null).length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of golden.excess) {
    it(`makes the calls of ${entry.name}`, async () => {
      const events: Event[] = [];
      const notified: string[] = [];
      const credits: { amountCentsUsd: number; amountCentsHoldingCurrency: number }[] = [];
      const { balance_transaction: bt } = entry.input;
      const context: ExcessContext = {
        holderOfFunds: entry.input.gumroad_held ? "gumroad" : "stripe",
        purchase: { gumroadTaxCents: 100, gumroadTaxRefundedCents: entry.input.prior_tax_cents, stripeTransactionId: "ch_golden" },
        merchantAccountId: ACCOUNT_ID,
        refund: { id: REFUND_ID, processorRefundId: PROCESSOR_REFUND_ID },
        sellerBalanceTransaction: bt ? { issuedAmountNetCents: bt.issued, holdingAmountNetCents: bt.holding, holdingAmountCurrency: bt.holding_currency } : null,
        notifyAlreadyReversed: (_error, transferId) => void notified.push(transferId),
        createCredit: async (credit) => void credits.push(credit),
      };
      const outcome = await outcomeOf(() => reverseExcessAmountFromStripeTransfer(scriptedStripe(entry.answers, events), context));
      expect(events).toEqual(entry.events);
      expect(outcome).toEqual(entry.outcome.raised ? entry.outcome : {});
      expect(notified.length).toBe(entry.name === "an amount that is already fully reversed" ? 1 : 0);
      expect(credits.length > 0 ? true : null).toBe(entry.outcome.returned ?? null);
      if (entry.credit) {
        expect(credits).toEqual([{ amountCentsUsd: entry.credit.amount_cents, amountCentsHoldingCurrency: entry.credit.balance_transaction.holding_amount_net_cents }]);
      }
    });
  }
});

describe("reverseTheTransferMadeForDisputeWin against the Ruby golden", () => {
  it("covers a full and a partial refund, a refund that did not debit the seller and the refusals", () => {
    expect(golden.dispute.length).toBeGreaterThanOrEqual(10);
    expect(golden.dispute.filter((entry) => entry.events.some((event) => event.call === "Transfer.create_reversal")).length).toBeGreaterThanOrEqual(3);
  });

  for (const entry of golden.dispute) {
    it(`makes the calls of ${entry.name}`, async () => {
      const events: Event[] = [];
      const { purchases, refunded } = entry.input;
      const refunds = entry.input.refunds ?? [{ total: purchases[0]!.total, tax: 0 }];
      const context: DisputeWinContext = {
        holderOfFunds: entry.input.gumroad_held ? "gumroad" : "stripe",
        disputeWonAtSeconds: entry.input.unwon ? null : WON_AT_SECONDS,
        chargeProcessorDisputeId: "dp_golden01",
        merchantAccountId: ACCOUNT_ID,
        purchases: purchases.map((purchase, index) => ({ totalTransactionCents: purchase.total, gumroadTaxCents: purchase.tax ?? 0, stripeRefunded: refunded[index]! })),
        refunds: refunds.map((refund) => ({
          totalTransactionCents: refund.total,
          gumroadTaxCents: refund.tax,
          gumroadFunded: refund.gumroad_funded === true,
          balanceReconciliationNeeded: false,
        })),
        refund: { id: REFUND_ID, processorRefundId: PROCESSOR_REFUND_ID },
      };
      const outcome = await outcomeOf(() => reverseTheTransferMadeForDisputeWin(scriptedStripe(entry.answers, events), context));
      expect(events).toEqual(entry.events);
      expect(outcome).toEqual(entry.outcome.raised ? entry.outcome : {});
    });
  }
});
