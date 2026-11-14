import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AMOUNT_TOO_LARGE,
  amountRefundableCents,
  balanceWrites,
  buildRefund,
  chooseRefund,
  effectiveSums,
  grossAmountRefundableCents,
  refundFlags,
  usdAmountToCents,
  type AffiliateCredit,
  type RefundRow,
  type RefundSale,
} from "./refund-ledger.ts";

type Golden = {
  refunding_user_id: number;
  cases: {
    name: string;
    input: { purchase: RefundSale; prior_refunds: RefundRow[]; affiliate_credit: AffiliateCredit | null };
    builds: {
      gross: number;
      refund: Record<string, number> | null;
      flags: { stripe_refunded: boolean; stripe_partially_refunded: boolean };
      split?: { writer: string; refund_cents: number; fee_cents?: number }[];
    }[];
    dispatches: {
      amount: string | null;
      result: boolean;
      refund_and_save: { amount_cents: number | null } | null;
      errors: string[];
    }[];
    refundable: { amount: number; gross: number };
  }[];
};

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/refund-ledger.golden.json", import.meta.url), "utf8"),
) as Golden;

describe("the refund ledger against the Ruby goldens", () => {
  for (const { name, input, builds, dispatches, refundable } of golden.cases) {
    const sale = input.purchase;
    const sums = effectiveSums(input.prior_refunds);

    describe(name, () => {
      it("computes what is still refundable", () => {
        expect({ amount: amountRefundableCents(sale, sums), gross: grossAmountRefundableCents(sale, sums) }).toEqual(
          refundable,
        );
      });

      it("builds the refund and splits it between the seller and the affiliate for every gross amount", () => {
        for (const build of builds) {
          const flags = refundFlags(sale, sums, build.gross);
          expect(flags, `flags of ${build.gross}`).toEqual(build.flags);
          const refund = buildRefund({
            sale,
            sums,
            flags,
            grossRefundAmount: build.gross,
            refundingUserId: golden.refunding_user_id,
          });
          expect(refund, `refund of ${build.gross}`).toEqual(build.refund);
          if (refund) {
            expect(balanceWrites(sale, input.affiliate_credit, refund), `balance writes of ${build.gross}`).toEqual(
              build.split!.filter((write) => write.refund_cents !== 0),
            );
          }
        }
      });

      it("chooses between a full refund, a partial one and a refusal for every amount typed", () => {
        for (const dispatch of dispatches) {
          const choice = chooseRefund(sale, sums, dispatch.amount);
          expect(choice, `amount ${String(dispatch.amount)}`).not.toBeNull();
          if (choice!.kind === "too_large") {
            expect(dispatch).toMatchObject({ result: false, refund_and_save: null, errors: [AMOUNT_TOO_LARGE] });
          } else {
            expect(dispatch.refund_and_save, `amount ${String(dispatch.amount)}`).toEqual({
              amount_cents: choice!.kind === "partial" ? choice!.amount_cents : null,
            });
          }
        }
      });
    });
  }

  it("covers a refusal, a full refund, a partial one and the rest of a partial one", () => {
    const flat = golden.cases.flatMap((entry) => entry.dispatches);
    expect(flat.some((entry) => entry.errors.length > 0)).toBe(true);
    expect(flat.some((entry) => entry.refund_and_save?.amount_cents === null)).toBe(true);
    expect(flat.some((entry) => typeof entry.refund_and_save?.amount_cents === "number")).toBe(true);
    expect(golden.cases.flatMap((entry) => entry.builds).some((entry) => entry.refund === null)).toBe(true);
  });
});

describe("usdAmountToCents", () => {
  it.each([
    ["1", 100],
    ["1.00", 100],
    ["0.5", 50],
    ["0.999", 99],
    ["12.", 1200],
    ["-0.5", -50],
  ])("reads %s as %i cents", (text, cents) => {
    expect(usdAmountToCents(text)).toBe(cents);
  });

  it.each(["1e2", ".5", "1,00", "abc", "1.0.0"])("refuses %s rather than guess how BigDecimal reads it", (text) => {
    expect(usdAmountToCents(text)).toBeNull();
  });
});
