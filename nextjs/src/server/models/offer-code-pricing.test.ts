// The price arithmetic of offer codes, renewals and installment plans against the real Ruby methods:
// worker/jobs/__fixtures__/offer-code-pricing-vectors.golden.json (scripts/golden/offer-code-pricing-vectors.rb)
// holds seeded random inputs and what OfferCode, Subscription and Purchase answered, errors included.
// The statements these methods send are pinned by subscription-reminder-jobs.test.ts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { amountOff, matchingTierFor, monthsSince, normalizeTiers, originalPrice, tiersOf } from "./offer-code.ts";
import {
  currencyMinPrice,
  installmentPaymentFor,
  installmentPayments,
  minimumPaidPrice,
  minimumPriceBeforeSplit,
  splitsIntoInstallments,
  type PricingInput,
} from "./purchase-pricing.ts";
import { autoRenewalDiscountedTotal, cachedTieredPwywPreDiscountTotal } from "./subscription-pricing.ts";

type Answer<T> = { value: T } | { error: string };
const golden = JSON.parse(readFileSync(new URL("../../worker/jobs/__fixtures__/offer-code-pricing-vectors.golden.json", import.meta.url), "utf8")) as {
  now: number;
  amounts: { amount_percentage: number | null; amount_cents: number | null; price: number; amount_off: Answer<number>; original_price: Answer<number | null> }[];
  months_since: { timestamp: string | null; months: Answer<number | null> }[];
  tiers: { tiers: Record<string, unknown>[]; queries: number[]; normalized: Answer<unknown>; matches: Answer<unknown>[] }[];
  installments: { total: number; number_of_installments: number; plan: Answer<number[]>; snapshot: Answer<number[]> }[];
  tiered_pwyw: { percent: number; pre_discount_minimum_price_cents: number; quantity: number; displayed: number; total: Answer<number | null> }[];
  discounted_totals: { is_percent: boolean; amount: number; once_per_cart: boolean; code_is_cents: boolean; quantity: number; unit: number; pre: number; currency: string; total: Answer<number> }[];
  minimum_paid_price: {
    quantity: number;
    unit: number;
    code: "percent" | "cents" | null;
    code_amount: number;
    once_per_cart: boolean;
    applies: boolean;
    currency: string;
    completion: boolean;
    commission_product: boolean;
    installment: boolean;
    ppp: boolean;
    ppp_enabled: boolean;
    nth: number;
    snapshot: boolean;
    snapshot_total: number;
    snapshot_installments: number;
    plan: boolean;
    number_of_installments: number;
    price: Answer<number>;
  }[];
  // A PPP-discounted price of a product that enabled PPP, with no offer code.
  minimum_paid_price_ppp: {
    quantity: number;
    unit: number;
    code: null;
    code_amount: number;
    once_per_cart: boolean;
    applies: boolean;
    currency: string;
    completion: boolean;
    commission_product: boolean;
    installment: boolean;
    nth: number;
    snapshot: boolean;
    snapshot_total: number;
    snapshot_installments: number;
    plan: boolean;
    number_of_installments: number;
    ppp_factor: number;
    price: Answer<number>;
  }[];
};

const NOW = new Date(Math.round(golden.now * 1000));

// What the Ruby method answered: a value, or the message of the error it raised.
function expectAnswer<T>(compute: () => T, expected: Answer<T>) {
  let outcome: Answer<T>;
  try {
    outcome = { value: compute() };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  expect(outcome).toEqual(expected);
}

describe("OfferCode#amount_off and #original_price", () => {
  it(`answers ${golden.amounts.length} seeded inputs as Ruby does`, () => {
    for (const v of golden.amounts) {
      const code = { amount_percentage: v.amount_percentage, amount_cents: v.amount_cents };
      expectAnswer(() => amountOff(code, v.price), v.amount_off);
      expectAnswer(() => originalPrice(code, v.price), v.original_price);
    }
  });

  it("rounds a half away from zero, as Float#round does", () => {
    expect(amountOff({ amount_percentage: 50, amount_cents: null }, 5)).toBe(3);
    expect(amountOff({ amount_percentage: 50, amount_cents: null }, -5)).toBe(-3);
    expect(amountOff({ amount_percentage: 10, amount_cents: null }, 25)).toBe(3);
  });
});

describe("OfferCode#months_since", () => {
  it(`answers ${golden.months_since.length} seeded timestamps as Ruby does`, () => {
    for (const v of golden.months_since) expectAnswer(() => monthsSince(v.timestamp === null ? null : new Date(v.timestamp), NOW), v.months);
  });
});

describe("OfferCode ownership duration tiers", () => {
  it(`normalizes and matches ${golden.tiers.length} seeded tier lists as Ruby does`, () => {
    for (const v of golden.tiers) {
      expectAnswer(() => normalizeTiers(tiersOf(v.tiers)), v.normalized);
      v.queries.forEach((months, i) => expectAnswer(() => matchingTierFor(normalizeTiers(tiersOf(v.tiers)), months) ?? null, v.matches[i]!));
    }
  });
});

describe("installment plan payments", () => {
  it(`splits ${golden.installments.length} seeded totals as the plan and the snapshot do`, () => {
    for (const v of golden.installments) {
      expectAnswer(() => installmentPayments(v.total, v.number_of_installments), v.plan);
      expectAnswer(() => installmentPayments(v.total, v.number_of_installments), v.snapshot);
    }
  });
});

describe("Subscription renewal arithmetic", () => {
  it(`undoes a tiered pay-what-you-want percentage for ${golden.tiered_pwyw.length} seeded purchases as Ruby does`, () => {
    for (const v of golden.tiered_pwyw) {
      expectAnswer(
        () => cachedTieredPwywPreDiscountTotal({ percent: v.percent, preDiscountMinimumPriceCents: v.pre_discount_minimum_price_cents, quantity: v.quantity, displayedPriceCents: v.displayed }),
        v.total,
      );
    }
  });

  it(`discounts ${golden.discounted_totals.length} seeded renewals as auto_renewal_discounted_total_cents does`, () => {
    for (const v of golden.discounted_totals) {
      expectAnswer(
        () =>
          autoRenewalDiscountedTotal({
            preDiscountTotalCents: v.pre,
            isPercent: v.is_percent,
            amount: v.amount,
            codeIsCents: v.code_is_cents,
            oncePerCart: v.once_per_cart,
            unitPriceCents: v.unit,
            quantity: v.quantity,
            minPrice: () => currencyMinPrice({ price_currency_type: v.currency }),
          }),
        v.total,
      );
    }
  });
});

describe("Purchase#minimum_paid_price_cents", () => {
  it(`prices ${golden.minimum_paid_price.length} seeded purchases as Ruby does`, () => {
    for (const v of golden.minimum_paid_price) {
      expectAnswer(() => {
        const input: PricingInput = {
          quantity: v.quantity,
          unitPriceCents: v.unit,
          code: v.code === null ? null : { amount_cents: v.code === "cents" ? v.code_amount : null, amount_percentage: v.code === "percent" ? v.code_amount : null, flags: v.once_per_cart ? 4n : 0n },
          codeApplies: v.applies,
          minPrice: () => currencyMinPrice({ price_currency_type: v.currency }),
          isCommissionCompletion: v.completion,
          isCommissionProduct: v.commission_product,
          isInstallmentPayment: v.installment,
          isPpp: v.ppp,
          pppEnabled: v.ppp_enabled,
        };
        const total = minimumPriceBeforeSplit(input);
        const payment = splitsIntoInstallments(input)
          ? installmentPaymentFor({
              totalPriceCents: total,
              nth: v.nth,
              snapshot: v.snapshot ? { total_price_cents: v.snapshot_total, number_of_installments: v.snapshot_installments } : null,
              plan: v.plan ? { number_of_installments: v.number_of_installments } : null,
            })
          : undefined;
        return minimumPaidPrice(input, total, payment);
      }, v.price);
    }
  });
});

describe("Purchase#minimum_paid_price_cents with a purchasing power parity factor", () => {
  it(`prices ${golden.minimum_paid_price_ppp.length} PPP-discounted purchases as Ruby does`, () => {
    for (const v of golden.minimum_paid_price_ppp) {
      expectAnswer(() => {
        const input: PricingInput = {
          quantity: v.quantity,
          unitPriceCents: v.unit,
          code: null,
          codeApplies: v.applies,
          minPrice: () => currencyMinPrice({ price_currency_type: v.currency }),
          isCommissionCompletion: v.completion,
          isCommissionProduct: v.commission_product,
          isInstallmentPayment: v.installment,
          isPpp: true,
          pppEnabled: true,
          pppFactor: v.ppp_factor,
        };
        const total = minimumPriceBeforeSplit(input);
        const payment = splitsIntoInstallments(input)
          ? installmentPaymentFor({
              totalPriceCents: total,
              nth: v.nth,
              snapshot: v.snapshot ? { total_price_cents: v.snapshot_total, number_of_installments: v.snapshot_installments } : null,
              plan: v.plan ? { number_of_installments: v.number_of_installments } : null,
            })
          : undefined;
        return minimumPaidPrice(input, total, payment);
      }, v.price);
    }
  });
});
