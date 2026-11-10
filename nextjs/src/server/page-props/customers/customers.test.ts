// The pure readings of CustomerPresenter / CustomersController that the recorded fixtures reach only in part.
import { beforeEach, describe, expect, it, vi } from "vitest";

const flipper = vi.hoisted(() => vi.fn());
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: flipper, userActor: (id: string) => `User;${id}` }));

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "customers-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { setSqlClient } from "../../models/sql.ts";
import { variantToOption } from "../../presenters/product-props.ts";

import {
  affiliateJson,
  displayReferrer,
  directCreditsOf,
  futureSubscriptionCharge,
  gifteeLicensesOf,
  giftOf,
  isPreorder,
  offerCodeReading,
  subscriptionStatus,
  transactionUrlForSeller,
  upsellNamesFor,
  pageOffset,
  refundableCents,
  refundIsEffective,
  rubyToI,
  totalPages,
} from "./customers.ts";

const purchase = (overrides: Record<string, unknown>) => ({
  flags: 0n,
  recommended_by: null,
  referrer: null,
  ...overrides,
});

describe("String#to_i", () => {
  it("reads the leading integer and treats anything else as zero", () => {
    expect([
      rubyToI("3"),
      rubyToI(" 12abc"),
      rubyToI("-4"),
      rubyToI("1_000"),
      rubyToI("abc"),
      rubyToI(undefined),
    ]).toEqual([3, 12, -4, 1000, 0, 0]);
  });
});

describe("pagination", () => {
  it("clamps the offset to the last legal Elasticsearch window", () => {
    expect([
      pageOffset(undefined),
      pageOffset("1"),
      pageOffset("2"),
      pageOffset("500"),
      pageOffset("9999"),
      pageOffset("-3"),
    ]).toEqual([0, 20, 40, 9980, 9980, 0]);
  });

  it("caps the page count at the result window", () => {
    expect([totalPages(0), totalPages(1), totalPages(20), totalPages(21), totalPages(1_000_000)]).toEqual([
      0, 1, 1, 2, 500,
    ]);
  });
});

describe("Purchase#display_referrer", () => {
  it("names the Gumroad surfaces a sale came through", () => {
    expect(displayReferrer(purchase({ recommended_by: "library" }), "seller")).toBe("Gumroad Library");
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "receipt" }), "seller")).toBe("Gumroad Receipt");
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "wishlist" }), "seller")).toBe(
      "Gumroad Wishlist",
    );
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "search" }), "seller")).toBe("Gumroad Discover");
  });

  it("names a referring site, the seller's own profile and direct visits", () => {
    expect(displayReferrer(purchase({ referrer: "direct" }), "seller")).toBe("Direct");
    expect(displayReferrer(purchase({ referrer: "https://t.co/abc" }), "seller")).toBe("Twitter");
    expect(displayReferrer(purchase({ referrer: "https://news.example.com/story" }), "seller")).toBe(
      "news.example.com",
    );
    expect(displayReferrer(purchase({ referrer: "https://seller.gumroad.com/l/x" }), "seller")).toBe("Profile");
    expect(displayReferrer(purchase({ referrer: "  " }), "seller")).toBeNull();
  });
});

describe("Refund#effective?", () => {
  it("counts every refund except a failed or canceled one whose balance was reversed", () => {
    expect(refundIsEffective({ status: "succeeded", json_data: null })).toBe(true);
    expect(refundIsEffective({ status: null, json_data: null })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: null })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: "{}" })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: '{"balance_reversed_on_failure":false}' })).toBe(true);
    expect(refundIsEffective({ status: "canceled", json_data: '{"balance_reversed_on_failure":true}' })).toBe(false);
    expect(refundIsEffective({ status: "succeeded", json_data: '{"balance_reversed_on_failure":true}' })).toBe(true);
  });

  it("hands back a failed refund whose json_data it cannot read as Ruby does", () => {
    expect(() => refundIsEffective({ status: "failed", json_data: "not json" })).toThrow(HandBackToRails);
    expect(() => refundIsEffective({ status: "failed", json_data: '{"balance_reversed_on_failure":1}' })).toThrow(
      HandBackToRails,
    );
  });
});

describe("Purchase#amount_refundable_cents_in_currency", () => {
  it("subtracts the effective refunds from the price of a sale charged through a known processor", async () => {
    expect(await refundableCents({ charge_processor_id: "stripe", price_cents: 500 }, 100, "usd")).toBe(400);
    expect(await refundableCents({ charge_processor_id: "paypal", price_cents: 500 }, 0, "usd")).toBe(500);
    expect(await refundableCents({ charge_processor_id: "paypal", price_cents: 500 }, 500, "usd")).toBe(0);
    expect(await refundableCents({ charge_processor_id: null, price_cents: 500 }, 0, "usd")).toBe(0);
  });

  it("converts the refundable dollars at the rate stored on the sale", async () => {
    expect(
      await refundableCents(
        { charge_processor_id: "stripe", price_cents: 1250, rate_converted_to_usd: "0.8" },
        250,
        "eur",
      ),
    ).toBe(800);
    expect(
      await refundableCents(
        { charge_processor_id: "stripe", price_cents: 1000, rate_converted_to_usd: "110" },
        0,
        "jpy",
      ),
    ).toBe(1100);
  });
});

describe("CustomerPresenter discount and cents_before_offer_code", () => {
  const CODE_ID = 11;
  const sale = (overrides: Record<string, unknown> = {}) => ({
    id: 5,
    offer_code_id: null,
    displayed_price_cents: 800,
    quantity: 2,
    flags: 0,
    ...overrides,
  });
  const code = (overrides: Record<string, unknown> = {}) => ({
    id: CODE_ID,
    code: "SPRING",
    flags: 0,
    amount_cents: null,
    amount_percentage: 20,
    deleted_at: null,
    ...overrides,
  });
  const discount = (overrides: Record<string, unknown> = {}) => ({
    purchase_id: 5,
    offer_code_id: CODE_ID,
    offer_code_amount: 20,
    offer_code_is_percent: true,
    once_per_cart: false,
    pre_discount_minimum_price_cents: 500,
    pre_discount_displayed_price_cents: null,
    ...overrides,
  });

  function answering(tables: {
    purchase_offer_code_discounts?: Record<string, unknown>[];
    offer_codes?: Record<string, unknown>[];
  }) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        if (query.sql.includes("FROM `purchase_offer_code_discounts`"))
          return tables.purchase_offer_code_discounts ?? [];
        if (query.sql.includes("FROM `offer_codes`")) return tables.offer_codes ?? [];
        if (query.sql.includes("FROM `tips`")) return [];
        throw new Error(`unexpected statement: ${query.sql}`);
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }

  it("reads the cached discount, not the code's current amount, once the code was edited", async () => {
    answering({
      purchase_offer_code_discounts: [discount({ offer_code_amount: 20 })],
      offer_codes: [code({ amount_percentage: 50 })],
    });

    expect(await offerCodeReading(sale(), null, true)).toEqual({
      discountCode: { amount_cents: null, amount_percentage: 20, code: "SPRING" },
      beforeOfferCode: 1000,
    });
  });

  it("reports a fixed cached discount with its cents", async () => {
    answering({
      purchase_offer_code_discounts: [discount({ offer_code_is_percent: false, offer_code_amount: 300 })],
      offer_codes: [code()],
    });

    expect((await offerCodeReading(sale(), null, true)).discountCode).toEqual({
      amount_cents: 300,
      amount_percentage: null,
      code: "SPRING",
    });
  });

  it("uses the stored pre-discount price of a once-per-cart fixed discount", async () => {
    answering({
      purchase_offer_code_discounts: [
        discount({
          offer_code_is_percent: false,
          offer_code_amount: 300,
          once_per_cart: true,
          pre_discount_displayed_price_cents: 1100,
        }),
      ],
      offer_codes: [code()],
    });

    expect((await offerCodeReading(sale(), null, true)).beforeOfferCode).toBe(1100);
  });

  it("adds the discount back to a once-per-cart fixed sale that stored no pre-discount price", async () => {
    answering({
      purchase_offer_code_discounts: [
        discount({ offer_code_is_percent: false, offer_code_amount: 300, once_per_cart: true }),
      ],
      offer_codes: [code()],
    });

    expect((await offerCodeReading(sale(), null, true)).beforeOfferCode).toBe(1100);
  });

  it("keeps reading the purchase's own code when no discount is cached", async () => {
    answering({});

    expect(await offerCodeReading(sale({ offer_code_id: CODE_ID }), code(), false)).toEqual({
      discountCode: code(),
      beforeOfferCode: 2000,
    });
  });

  it("hides a deleted code's discount but still lists the price before it", async () => {
    answering({});

    expect(
      await offerCodeReading(sale({ offer_code_id: CODE_ID }), code({ deleted_at: new Date() }), false),
    ).toMatchObject({ discountCode: null, beforeOfferCode: 2000 });
  });

  it("has no discount and the displayed price for a sale without a code", async () => {
    answering({});

    expect(await offerCodeReading(sale(), null, false)).toEqual({ discountCode: null, beforeOfferCode: 800 });
  });
});

describe("CustomerPresenter affiliate", () => {
  const user = { email: "affiliate@example.com", unconfirmed_email: null };

  it("shows the affiliate's email, the credit this sale paid them and their type", () => {
    expect(affiliateJson({ affiliate_credit_cents: 1250 }, { type: "DirectAffiliate" }, user)).toEqual({
      email: "affiliate@example.com",
      amount: "$12.50",
      type: "DirectAffiliate",
    });
  });

  it("drops the cents of a whole-dollar credit and groups thousands", () => {
    expect(affiliateJson({ affiliate_credit_cents: 500 }, { type: "GlobalAffiliate" }, user).amount).toBe("$5");
    expect(affiliateJson({ affiliate_credit_cents: 123456 }, { type: "Collaborator" }, user).amount).toBe("$1,234.56");
  });

  it("prefers the unconfirmed email, as User#form_email does, and treats a missing credit as zero", () => {
    const pending = { email: "old@example.com", unconfirmed_email: "new@example.com" };

    expect(affiliateJson({ affiliate_credit_cents: null }, { type: "DirectAffiliate" }, pending)).toMatchObject({
      email: "new@example.com",
      amount: "$0",
    });
    expect(
      affiliateJson({ affiliate_credit_cents: 0 }, { type: "DirectAffiliate" }, { email: " ", unconfirmed_email: "" })
        .email,
    ).toBeNull();
  });
});

describe("Variant#to_option on a customer", () => {
  const TIERED_FLAG = 1n << 18n;
  const product = (overrides: Record<string, unknown> = {}) =>
    ({ id: 3, name: "Course", flags: 0n, user_id: 9, ...overrides }) as never;
  const variant = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 7,
      name: "Large",
      description: "Big one",
      price_difference_cents: 300,
      max_purchase_count: null,
      sales_count_for_inventory_cache: 0,
      customizable_price: 0,
      duration_in_minutes: null,
      flags: 0,
      deleted_at: null,
      ...overrides,
    }) as never;

  it("describes the option the buyer picked", async () => {
    expect(await variantToOption(product(), variant(), [], 9n)).toMatchObject({
      name: "Large",
      description: "Big one",
      price_difference_cents: 300,
      quantity_left: null,
      recurrence_price_values: null,
      is_pwyw: false,
      duration_in_minutes: null,
    });
  });

  it("takes the product's name for an untitled option and an empty string for a missing one", async () => {
    expect((await variantToOption(product(), variant({ name: "Untitled" }), [], 9n)).name).toBe("Course");
    expect(await variantToOption(product(), variant({ name: null, description: null }), [], 9n)).toMatchObject({
      name: "",
      description: "",
    });
  });

  it("counts the stock left, never below zero", async () => {
    expect(
      (
        await variantToOption(
          product(),
          variant({ max_purchase_count: 10, sales_count_for_inventory_cache: 4 }),
          [],
          9n,
        )
      ).quantity_left,
    ).toBe(6);
    expect(
      (await variantToOption(product(), variant({ max_purchase_count: 2, sales_count_for_inventory_cache: 5 }), [], 9n))
        .quantity_left,
    ).toBe(0);
    expect(
      (
        await variantToOption(
          product(),
          variant({ max_purchase_count: 2, sales_count_for_inventory_cache: null }),
          [],
          9n,
        )
      ).quantity_left,
    ).toBe(2);
  });

  it("flags a pay-what-you-want option and keeps a call's duration", async () => {
    expect(
      await variantToOption(product(), variant({ customizable_price: 1, duration_in_minutes: 30 }), [], 9n),
    ).toMatchObject({ is_pwyw: true, duration_in_minutes: 30 });
  });

  describe("a tier of a membership", () => {
    const monthlyPrice = { id: 1, link_id: 3, recurrence: "monthly", price_cents: 500, flags: 0 };

    function answering(prices: Record<string, unknown>[]) {
      setSqlClient(() => ({
        $queryRaw: (async (query: { sql: string }) => {
          if (query.sql.includes("FROM `prices`")) return prices;
          throw new Error(`unexpected statement: ${query.sql}`);
        }) as never,
        $executeRaw: (async () => 0) as never,
      }));
    }

    beforeEach(() => flipper.mockResolvedValue(false));

    it("lists the tier's price for each recurrence the product offers", async () => {
      answering([
        { id: 2, variant_id: 7, recurrence: "monthly", price_cents: 700, suggested_price_cents: null, flags: 0 },
      ]);

      const option = await variantToOption(product({ flags: TIERED_FLAG }), variant(), [monthlyPrice] as never, 9n);

      expect(option.recurrence_price_values).toEqual({ monthly: { price_cents: 700, suggested_price_cents: null } });
    });

    it("lists no price for a tier that was deleted since", async () => {
      answering([
        { id: 2, variant_id: 7, recurrence: "monthly", price_cents: 700, suggested_price_cents: null, flags: 0 },
      ]);

      const option = await variantToOption(
        product({ flags: TIERED_FLAG }),
        variant({ deleted_at: new Date() }),
        [monthlyPrice] as never,
        9n,
      );

      expect(option.recurrence_price_values).toEqual({});
    });

    it("reports no stock for a tier closed to new buyers when the seller has the feature", async () => {
      answering([]);
      flipper.mockResolvedValue(true);

      const option = await variantToOption(
        product({ flags: TIERED_FLAG }),
        variant({ flags: 1 << 2, max_purchase_count: 10 }),
        [],
        9n,
      );

      expect(option.quantity_left).toBe(0);
      expect(flipper).toHaveBeenCalledWith("close_membership_tier_to_new_buyers", "User;9");
    });
  });
});

describe("Subscription#status", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");
  const past = new Date("2026-05-01T00:00:00Z");
  const future = new Date("2026-07-01T00:00:00Z");
  const row = (overrides: Record<string, unknown> = {}) => ({
    deactivated_at: null,
    failed_at: null,
    ended_at: null,
    cancelled_at: null,
    ...overrides,
  });

  it("is alive for a running subscription", () => {
    expect(subscriptionStatus(row(), "successful", NOW)).toBe("alive");
    expect(subscriptionStatus(row(), null, NOW)).toBe("alive");
  });

  it("is pending failure when the newest charge failed and pending cancellation when it ends in the future", () => {
    expect(subscriptionStatus(row(), "failed", NOW)).toBe("pending_failure");
    expect(subscriptionStatus(row({ cancelled_at: future }), "successful", NOW)).toBe("pending_cancellation");
    expect(subscriptionStatus(row({ cancelled_at: future }), "failed", NOW)).toBe("pending_failure");
  });

  it("names why a deactivated subscription ended, failure first", () => {
    expect(subscriptionStatus(row({ deactivated_at: past, failed_at: past, cancelled_at: past }), "failed", NOW)).toBe(
      "failed_payment",
    );
    expect(subscriptionStatus(row({ deactivated_at: past, ended_at: past }), null, NOW)).toBe(
      "fixed_subscription_period_ended",
    );
    expect(subscriptionStatus(row({ deactivated_at: past, cancelled_at: past }), null, NOW)).toBe("cancelled");
    expect(subscriptionStatus(row({ deactivated_at: past }), null, NOW)).toBeNull();
  });

  it("is not alive once its cancellation date passed, so a failed charge no longer makes it pending", () => {
    expect(subscriptionStatus(row({ cancelled_at: past }), "failed", NOW)).toBe("alive");
  });

  it("asks for a new payment method only where the member would otherwise be alive", () => {
    expect(subscriptionStatus(row(), "successful", NOW, true)).toBe("payment_method_update_required");
    expect(subscriptionStatus(row({ cancelled_at: future }), "successful", NOW, true)).toBe("pending_cancellation");
    expect(subscriptionStatus(row(), "failed", NOW, true)).toBe("pending_failure");
    expect(subscriptionStatus(row({ deactivated_at: past, cancelled_at: past }), null, NOW, true)).toBe("cancelled");
  });
});

describe("Subscription#future_subscription_charge?", () => {
  it("is false once the fixed number of charges is done, whatever the price", () => {
    expect(futureSubscriptionCharge(true, 500, true)).toBe(false);
  });

  it("is true while the renewal price is positive", () => {
    expect(futureSubscriptionCharge(false, 500, false)).toBe(true);
    expect(futureSubscriptionCharge(false, 500, true)).toBe(true);
  });

  it("is false for a free renewal without a limited-cycle discount", () => {
    expect(futureSubscriptionCharge(false, 0, false)).toBe(false);
    expect(futureSubscriptionCharge(false, null, false)).toBe(false);
  });

  it("hands back a free renewal under a limited-cycle discount", () => {
    expect(() => futureSubscriptionCharge(false, 0, true)).toThrow(HandBackToRails);
  });
});

describe("CustomerPresenter upsell", () => {
  function answering(upsellPurchases: Record<string, unknown>[], upsells: Record<string, unknown>[]) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        if (query.sql.includes("FROM `upsell_purchases`")) return upsellPurchases;
        if (query.sql.includes("FROM `upsells`")) return upsells;
        throw new Error(`unexpected statement: ${query.sql}`);
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }

  it("names the upsell each purchase was sold through", async () => {
    answering(
      [
        { id: 1, purchase_id: 5, upsell_id: 9 },
        { id: 2, purchase_id: 6, upsell_id: 9 },
      ],
      [{ id: 9, name: "Add the workbook" }],
    );

    expect(await upsellNamesFor([5, 6, 7])).toEqual(
      new Map([
        ["5", "Add the workbook"],
        ["6", "Add the workbook"],
      ]),
    );
  });

  it("reports no name for an unnamed or missing upsell", async () => {
    answering(
      [
        { id: 1, purchase_id: 5, upsell_id: 9 },
        { id: 2, purchase_id: 6, upsell_id: 10 },
      ],
      [{ id: 9, name: null }],
    );

    expect(await upsellNamesFor([5, 6])).toEqual(
      new Map([
        ["5", null],
        ["6", null],
      ]),
    );
  });

  it("reads nothing for a page without purchases", async () => {
    answering([], []);

    expect((await upsellNamesFor([])).size).toBe(0);
  });
});

describe("Purchase#gift", () => {
  const SENDER_FLAG = 1n << 6n;
  const RECEIVER_FLAG = 1n << 5n;
  const loaded = {
    gifts: new Map([["1", { giftee_email: "sent-to@example.com" }]]),
    receivedGifts: new Map([["2", { giftee_email: "received-by@example.com" }]]),
  };

  it("is the gift a sender gave and the gift a receiver was handed", () => {
    expect(giftOf({ id: 1, flags: SENDER_FLAG }, loaded)).toEqual({ giftee_email: "sent-to@example.com" });
    expect(giftOf({ id: 2, flags: RECEIVER_FLAG }, loaded)).toEqual({ giftee_email: "received-by@example.com" });
  });

  it("is nothing for a purchase that is neither, even when a gift row shares its id", () => {
    expect(giftOf({ id: 1, flags: 0n }, loaded)).toBeUndefined();
    expect(giftOf({ id: 2, flags: SENDER_FLAG }, loaded)).toBeUndefined();
  });
});

describe("CustomerPresenter is_preorder", () => {
  const AUTHORIZATION_FLAG = 1n << 3n;
  const preorders = new Set(["9"]);

  it("is true for the authorization of an existing preorder", () => {
    expect(isPreorder({ preorder_id: 9, flags: AUTHORIZATION_FLAG }, preorders)).toBe(true);
  });

  it("is false for the purchase a preorder was charged as, and for a preorder that no longer exists", () => {
    expect(isPreorder({ preorder_id: 9, flags: 0n }, preorders)).toBe(false);
    expect(isPreorder({ preorder_id: 10, flags: AUTHORIZATION_FLAG }, preorders)).toBe(false);
  });

  it("is false for a purchase without a preorder", () => {
    expect(isPreorder({ preorder_id: null, flags: AUTHORIZATION_FLAG }, preorders)).toBe(false);
  });
});

describe("Purchase#transaction_url_for_seller", () => {
  const sale = (overrides: Record<string, unknown> = {}) => ({
    charge_processor_id: "stripe",
    stripe_transaction_id: "ch_123",
    ...overrides,
  });
  const connectAccount = { charge_processor_id: "stripe", user_id: 5, json_data: '{"meta":{"stripe_connect":"true"}}' };
  const gumroadAccount = { charge_processor_id: "stripe", user_id: null, json_data: null };

  it("links a sale charged through the seller's Stripe Connect account to Stripe's dashboard", () => {
    expect(transactionUrlForSeller(sale(), connectAccount, "production")).toBe(
      "https://manage.stripe.com/payments/ch_123",
    );
    expect(transactionUrlForSeller(sale(), connectAccount, "staging")).toBe(
      "https://manage.stripe.com/test/payments/ch_123",
    );
  });

  it("links a PayPal sale to PayPal's transaction history, or its sandbox outside production", () => {
    const paypal = sale({ charge_processor_id: "paypal", stripe_transaction_id: "PAY-1" });

    expect(transactionUrlForSeller(paypal, null, "production")).toBe(
      "https://history.paypal.com/us/cgi-bin/webscr?cmd=_history-details-from-hub&id=PAY-1",
    );
    expect(transactionUrlForSeller(paypal, null, "development")).toBe(
      "https://sandbox.paypal.com/us/cgi-bin/webscr?cmd=_history-details-from-hub&id=PAY-1",
    );
  });

  it("is nil for a sale charged through Gumroad's own Stripe account, with or without a merchant account row", () => {
    expect(transactionUrlForSeller(sale(), gumroadAccount, "production")).toBeNull();
    expect(transactionUrlForSeller(sale(), null, "production")).toBeNull();
  });

  it("is nil for a sale with no processor or no charge id", () => {
    expect(transactionUrlForSeller(sale({ charge_processor_id: null }), connectAccount, "production")).toBeNull();
    expect(transactionUrlForSeller(sale({ stripe_transaction_id: " " }), connectAccount, "production")).toBeNull();
  });

  it("links a Braintree sale to the merchant's transaction page", () => {
    vi.stubEnv("BRAINTREE_MERCHANT_ID", "merch123");
    const braintree = sale({ charge_processor_id: "braintree" });
    expect(transactionUrlForSeller(braintree, null, "production")).toBe(
      "https://www.braintreegateway.com/merchants/merch123/transactions/ch_123",
    );
    expect(transactionUrlForSeller(braintree, null, "test")).toBe(
      "https://sandbox.braintreegateway.com/merchants/merch123/transactions/ch_123",
    );
    vi.unstubAllEnvs();
  });
});

function answeringTables(tables: Record<string, Record<string, unknown>[]>) {
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      for (const [name, rows] of Object.entries(tables)) if (query.sql.includes(`FROM \`${name}\``)) return rows;
      throw new Error(`unexpected statement: ${query.sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

describe("Purchase#own_affiliate_credit_cents", () => {
  const collaborators = new Map([["9", { id: 9, type: "Collaborator" }]]);
  const sale = (json_data: string, affiliate_id: unknown = 9) => ({ id: 1, affiliate_id, json_data });

  it("takes the direct affiliate's part off a collaborator sale that credits a DirectAffiliate", async () => {
    answeringTables({ affiliates: [{ id: 5, type: "DirectAffiliate" }] });
    const credits = await directCreditsOf(
      [sale('{"direct_affiliate_id":5,"direct_affiliate_credit_cents":120}')],
      collaborators,
    );
    expect(credits).toEqual(new Map([["1", 120]]));
    expect(
      affiliateJson({ affiliate_credit_cents: 500 }, { type: "Collaborator" }, { email: "a@example.com" }, 120).amount,
    ).toBe("$3.80");
  });

  it("leaves the credit whole when the direct affiliate is gone, is not a DirectAffiliate or the affiliate is not a collaborator", async () => {
    answeringTables({ affiliates: [{ id: 5, type: "GlobalAffiliate" }] });
    const json = '{"direct_affiliate_id":5,"direct_affiliate_credit_cents":120}';
    expect((await directCreditsOf([sale(json)], collaborators)).size).toBe(0);
    answeringTables({ affiliates: [] });
    expect((await directCreditsOf([sale(json)], collaborators)).size).toBe(0);
    expect((await directCreditsOf([sale(json)], new Map([["9", { id: 9, type: "DirectAffiliate" }]]))).size).toBe(0);
  });

  it("hands back json_data it cannot read", async () => {
    await expect(directCreditsOf([sale("direct_affiliate_id: 5")], collaborators)).rejects.toThrow(HandBackToRails);
    answeringTables({ affiliates: [{ id: 5, type: "DirectAffiliate" }] });
    await expect(
      directCreditsOf([sale('{"direct_affiliate_id":5,"direct_affiliate_credit_cents":"12"}')], collaborators),
    ).rejects.toThrow(HandBackToRails);
  });
});

describe("Purchase#linked_license of a gift sender", () => {
  const gifts = new Map([["1", { giftee_purchase_id: 2 }]]);
  const LICENSED = 1n << 6n;

  it("is the license of the giftee's purchase of a licensed product", async () => {
    answeringTables({
      licenses: [{ id: 7, purchase_id: 2, serial: "KEY-1" }],
      purchases: [{ id: 2, link_id: 3 }],
      links: [{ id: 3, flags: LICENSED }],
      base_variants_purchases: [],
    });
    expect((await gifteeLicensesOf(gifts)).get("1")).toMatchObject({ id: 7, serial: "KEY-1" });
  });

  it("is nothing when the giftee holds no license or the product is not licensed", async () => {
    answeringTables({ licenses: [] });
    expect((await gifteeLicensesOf(gifts)).size).toBe(0);
    answeringTables({
      licenses: [{ id: 7, purchase_id: 2, serial: "KEY-1" }],
      purchases: [{ id: 2, link_id: 3 }],
      links: [{ id: 3, flags: 0n }],
    });
    expect((await gifteeLicensesOf(gifts)).size).toBe(0);
  });

  it("hands back when the giftee chose an option, whose content may leave out the license key", async () => {
    answeringTables({
      licenses: [{ id: 7, purchase_id: 2, serial: "KEY-1" }],
      purchases: [{ id: 2, link_id: 3 }],
      links: [{ id: 3, flags: LICENSED }],
      base_variants_purchases: [{ id: 1, purchase_id: 2, base_variant_id: 4 }],
    });
    await expect(gifteeLicensesOf(gifts)).rejects.toThrow(HandBackToRails);
  });
});
