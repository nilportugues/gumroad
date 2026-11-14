// Replays __fixtures__/balance-transaction-amounts.golden.json (scripts/golden/balance-transaction-amounts.rb): the real
// BalanceTransaction::Amount factories.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as amounts from "./balance-transaction-amounts.ts";

type Pair = [string, number] | null;
type Out = { currency: string; gross_cents: number; net_cents: number };
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/balance-transaction-amounts.golden.json"), "utf8"),
) as {
  seller: {
    input: {
      flow_of_funds: { issued: Pair; settled: Pair; gumroad: Pair; gross: Pair; net: Pair };
      canonical_issued_amount: Pair;
      gumroad_held: boolean | null;
      issued_net_cents: number;
    };
    output: { issued: Out; holding: Out };
  }[];
  affiliate: {
    input: { issued_affiliate_cents: number; currency: string | null };
    output: { issued: Out; holding: Out };
  }[];
};

const amountOf = (pair: Pair) => (pair === null ? null : { currency: pair[0], cents: pair[1] });
const wire = (value: { currency: string; grossCents: number; netCents: number }): Out => ({
  currency: value.currency,
  gross_cents: value.grossCents,
  net_cents: value.netCents,
});

describe("BalanceTransaction::Amount for a seller", () => {
  it("answers the issued and holding amounts of every flow, canonical amount and holder of the golden", () => {
    expect(golden.seller.length).toBeGreaterThan(200);
    for (const { input, output } of golden.seller) {
      const flow = input.flow_of_funds;
      const flowOfFunds = {
        issuedAmount: amountOf(flow.issued)!,
        settledAmount: amountOf(flow.settled),
        gumroadAmount: amountOf(flow.gumroad)!,
        merchantAccountGrossAmount: amountOf(flow.gross),
        merchantAccountNetAmount: amountOf(flow.net),
      };
      const canonicalIssuedAmount = amountOf(input.canonical_issued_amount);
      const label = JSON.stringify(input);
      expect(
        wire(
          amounts.issuedAmountForSeller({ flowOfFunds, issuedNetCents: input.issued_net_cents, canonicalIssuedAmount }),
        ),
        label,
      ).toEqual(output.issued);
      expect(
        wire(
          amounts.holdingAmountForSeller({
            flowOfFunds,
            issuedNetCents: input.issued_net_cents,
            canonicalIssuedAmount,
            gumroadHeld: input.gumroad_held === true,
          }),
        ),
        label,
      ).toEqual(output.holding);
    }
  });
});

describe("BalanceTransaction::Amount for an affiliate", () => {
  it("is canonical dollars unless a reversal follows another ledger's label", () => {
    for (const { input, output } of golden.affiliate) {
      const issued =
        input.currency === null
          ? amounts.affiliateAmount(input.issued_affiliate_cents)
          : amounts.affiliateAmount(input.issued_affiliate_cents, input.currency);
      expect(wire(issued)).toEqual(output.issued);
      expect(wire(issued)).toEqual(output.holding);
    }
  });
});
