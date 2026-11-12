// Replays __fixtures__/purchase-fees.golden.json (scripts/golden/purchase-fees.rb): the real Purchase#calculate_fees.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as fees from "./purchase-fees.ts";

type Input = {
  price_cents: number;
  waive: boolean;
  high_volume: boolean;
  gumroad_account: boolean;
  discover: boolean;
  custom_fee: number | null;
  seller_custom_fee: number | null;
  brazilian: boolean;
  pix: boolean;
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/purchase-fees.golden.json", import.meta.url), "utf8"),
) as {
  constants: Record<string, number>;
  cases: { input: Input; output: { fee_cents: number; was_discover_fee_charged: boolean } }[];
};

const factsOf = (input: Input): fees.FeeFacts => ({
  priceCents: input.price_cents,
  waiveGumroadFee: input.waive,
  highVolumeSeller: input.high_volume,
  chargedUsingGumroadMerchantAccount: input.gumroad_account,
  chargeDiscoverFee: input.discover,
  customFeePerThousand: input.custom_fee,
  sellerCustomFeePerThousand: input.seller_custom_fee,
  brazilianStripeConnectAccount: input.brazilian,
  pix: input.pix,
});

describe("Purchase#calculate_fees", () => {
  it("uses the constants Ruby has", () => {
    const { constants } = golden;
    expect(constants).toEqual({
      GUMROAD_FLAT_FEE_PER_THOUSAND: fees.GUMROAD_FLAT_FEE_PER_THOUSAND,
      GUMROAD_DISCOVER_FEE_PER_THOUSAND: fees.GUMROAD_DISCOVER_FEE_PER_THOUSAND,
      GUMROAD_DISCOVER_EXTRA_FEE_PER_THOUSAND: fees.GUMROAD_DISCOVER_EXTRA_FEE_PER_THOUSAND,
      GUMROAD_FIXED_FEE_CENTS: fees.GUMROAD_FIXED_FEE_CENTS,
      PROCESSOR_FEE_PER_THOUSAND: fees.PROCESSOR_FEE_PER_THOUSAND,
      PROCESSOR_FIXED_FEE_CENTS: fees.PROCESSOR_FIXED_FEE_CENTS,
      PIX_IOF_FEE_PER_THOUSAND: fees.PIX_IOF_FEE_PER_THOUSAND,
      HIGH_VOLUME_FEE_PER_THOUSAND: fees.HIGH_VOLUME_FEE_PER_THOUSAND,
    });
  });

  it("answers the fee of the recorded $5 purchase", () => {
    const plain = golden.cases.find(
      ({ input }) =>
        input.price_cents === 500 &&
        !input.waive &&
        !input.high_volume &&
        input.gumroad_account &&
        !input.discover &&
        input.custom_fee === null &&
        input.seller_custom_fee === null &&
        !input.brazilian &&
        !input.pix,
    )!;
    // fee_cents of the purchases row in orders_paid_purchase_parity_spec.rb
    expect(plain.output.fee_cents).toBe(145);
    expect(fees.calculateFees(factsOf(plain.input)).feeCents).toBe(145);
  });

  it("matches every case Ruby answered", () => {
    expect(golden.cases.length).toBeGreaterThan(2000);
    const wrong = golden.cases.filter(({ input, output }) => {
      const got = fees.calculateFees(factsOf(input));
      return got.feeCents !== output.fee_cents || got.wasDiscoverFeeCharged !== output.was_discover_fee_charged;
    });
    expect(wrong.map(({ input }) => JSON.stringify(input))).toEqual([]);
  });
});
