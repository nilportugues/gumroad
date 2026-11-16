// Replays __fixtures__/purchase-charge-facts.golden.json (scripts/golden/purchase-charge-facts.rb): the real Ruby predicates.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as facts from "./purchase-charge-facts.ts";

type AccountSpec = {
  processor: string;
  connect: boolean;
  country: string;
  alive: boolean;
  processor_deleted: boolean;
  deleted: boolean;
};
type Golden = {
  constants: { cross_border_country: string; free_recommendation_types: string[] };
  high_volume: { input: { feature_active: boolean; month: string | null; now: string }; output: boolean }[];
  merchant_account: {
    input: {
      accounts: AccountSpec[];
      linked: boolean;
      processor: string;
      recurring_upi: boolean;
      has_affiliate: boolean;
    };
    output: {
      seller_account: number | null;
      chosen: number | string | null;
      charged_using_gumroad_merchant_account: boolean;
      brazilian_connect: boolean;
      error_code: string | null;
      error_messages: string[];
    };
  }[];
  discover_fee: {
    input: {
      recommendable: boolean;
      not_original_subscription_purchase: boolean;
      original_discover_fee_charged: boolean | null;
      recommended: boolean;
      recommended_by: string | null;
    };
    output: boolean;
  }[];
  card_type: {
    token: { input: { brand: string | null }; output: string | null }[];
    payment_method: {
      input: { brand: string | null; type: string | null; card_block: boolean; no_payment_method?: true };
      output: string | null;
    }[];
  };
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/purchase-charge-facts.golden.json", import.meta.url), "utf8"),
) as Golden;

const GUMROAD_STRIPE = {
  id: "gumroad_stripe",
  user_id: null,
  charge_processor_id: "stripe",
  country: null,
  json_data: null,
  deleted_at: null,
  charge_processor_alive_at: 1,
  charge_processor_deleted_at: null,
};
const GUMROAD_PAYPAL = { ...GUMROAD_STRIPE, id: "gumroad_paypal", charge_processor_id: "paypal" };

const rowOf = (spec: AccountSpec, index: number): facts.ChargeMerchantAccount => ({
  id: index,
  user_id: 7,
  charge_processor_id: spec.processor,
  country: spec.country,
  json_data: spec.connect ? JSON.stringify({ meta: { stripe_connect: "true" } }) : null,
  deleted_at: spec.deleted ? 1 : null,
  charge_processor_alive_at: spec.alive ? 1 : null,
  charge_processor_deleted_at: spec.processor_deleted ? 1 : null,
});

describe("User#high_volume_seller_fee?", () => {
  it("answers every flag, stored month and clock of the golden", () => {
    for (const { input, output } of golden.high_volume) {
      expect(
        facts.highVolumeSellerFee({
          featureActive: input.feature_active,
          month: input.month,
          now: new Date(input.now),
        }),
        JSON.stringify(input),
      ).toBe(output);
    }
  });
});

describe("the merchant account a paid purchase is charged on", () => {
  it("picks the seller's account and the Gumroad fallback as Rails does", () => {
    expect(golden.merchant_account.length).toBeGreaterThan(200);
    for (const { input, output } of golden.merchant_account) {
      const sellerAccounts = input.accounts.map(rowOf);
      const seller = facts.sellerMerchantAccount(sellerAccounts, input.processor, input.linked);
      expect(seller === null ? null : sellerAccounts.indexOf(seller), JSON.stringify(input)).toBe(
        output.seller_account,
      );

      const prepared = facts.prepareMerchantAccount({
        sellerAccounts,
        gumroadAccounts: [GUMROAD_STRIPE, GUMROAD_PAYPAL],
        processor: input.processor,
        merchantMigrationEnabled: input.linked,
        recurringUpi: input.recurring_upi,
        hasAffiliate: input.has_affiliate,
      });
      const chosen =
        prepared.account === null
          ? null
          : prepared.account === GUMROAD_STRIPE
            ? "gumroad_stripe"
            : prepared.account === GUMROAD_PAYPAL
              ? "gumroad_paypal"
              : sellerAccounts.indexOf(prepared.account);
      expect(chosen, JSON.stringify(input)).toBe(output.chosen);
      expect(prepared.error?.code ?? null, JSON.stringify(input)).toBe(output.error_code);
      expect(prepared.error === null ? [] : [prepared.error.message]).toEqual(output.error_messages);
      expect(facts.chargedUsingGumroadMerchantAccount(prepared.account, input.processor), JSON.stringify(input)).toBe(
        output.charged_using_gumroad_merchant_account,
      );
      expect(prepared.account !== null && facts.isBrazilianStripeConnect(prepared.account)).toBe(
        output.brazilian_connect,
      );
    }
  });

  it("uses the cross-border country the golden does", () => {
    expect(golden.constants.cross_border_country).toBe("TH");
    expect(
      facts.sellerMerchantAccount(
        [
          rowOf(
            {
              processor: "stripe",
              connect: false,
              country: "TH",
              alive: true,
              processor_deleted: false,
              deleted: false,
            },
            0,
          ),
        ],
        "stripe",
        false,
      ),
    ).toBeNull();
  });
});

describe("Purchase#charge_discover_fee?", () => {
  it("answers every recommendation type, product and original purchase of the golden", () => {
    expect(golden.constants.free_recommendation_types).toEqual([...facts.FREE_RECOMMENDATION_TYPES]);
    expect(golden.discover_fee.length).toBeGreaterThan(300);
    for (const { input, output } of golden.discover_fee) {
      expect(
        facts.chargeDiscoverFee({
          productRecommendable: input.recommendable,
          notOriginalSubscriptionPurchase: input.not_original_subscription_purchase,
          originalDiscoverFeeCharged: input.original_discover_fee_charged,
          wasProductRecommended: input.recommended,
          recommendedBy: input.recommended_by,
        }),
        JSON.stringify(input),
      ).toBe(output);
    }
  });
});

describe("the card type a Stripe chargeable reports", () => {
  it("maps a token's legacy brand as Rails does", () => {
    for (const { input, output } of golden.card_type.token)
      expect(facts.tokenCardType(input.brand), JSON.stringify(input)).toBe(output);
  });

  it("maps a payment method's brand, then its own type, as Rails does", () => {
    for (const { input, output } of golden.card_type.payment_method) {
      const answer = input.no_payment_method
        ? facts.paymentMethodCardType({ brand: null, methodType: null })
        : facts.paymentMethodCardType({ brand: input.card_block ? input.brand : null, methodType: input.type });
      expect(answer, JSON.stringify(input)).toBe(output);
    }
  });

  it("takes the Pix card type from the payment method type", () => {
    expect(facts.paymentMethodCardType({ brand: null, methodType: "pix" })).toBe(facts.CARD_TYPE_PIX);
  });
});
