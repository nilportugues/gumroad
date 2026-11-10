// The pure readings of CustomerPresenter / CustomersController that the recorded fixtures reach only in part.
import { beforeEach, describe, expect, it, vi } from "vitest";

const flipper = vi.hoisted(() => vi.fn());
const videoThumbnail = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("../signed-in/thumbnails.ts", () => ({ videoFileThumbnailUrl: videoThumbnail }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: flipper, userActor: (id: string) => `User;${id}` }));

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "customers-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { setSqlClient } from "../../models/sql.ts";
import { variantToOption } from "../../presenters/product-props.ts";

import {
  affiliateJson,
  commissionReadings,
  shownReviewVideos,
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
  utmLinkReadings,
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
});

describe("commissions and review videos", () => {
  const DEPOSIT = 1n << 28n;
  const COMPLETION = 1n << 29n;
  type Tables = Record<string, Record<string, unknown>[]>;
  function answering(tables: Tables) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        for (const [key, rows] of Object.entries(tables)) {
          const [name, byColumn] = key.split(":");
          if (query.sql.includes(`FROM \`${name}\``) && (!byColumn || query.sql.includes(`\`${byColumn}\` IN`)))
            return rows;
        }
        return [];
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }
  const deposit = { id: 10, flags: DEPOSIT };
  const commission = { id: 3, deposit_purchase_id: 10, completion_purchase_id: null, status: "in_progress" };
  const asDeposit = "commissions:deposit_purchase_id";

  it("reads an open commission as editable with no completion", async () => {
    answering({ [asDeposit]: [commission] });

    const readings = await commissionReadings([deposit]);

    expect(readings.get("10")).toMatchObject({ status: "in_progress", filesAreEditable: true, completion: null });
  });

  it("folds a charged completion into the deposit row and locks the files", async () => {
    answering({
      [asDeposit]: [{ ...commission, completion_purchase_id: 11, status: "completed" }],
      purchases: [{ id: 11, purchase_state: "successful", displayed_price_cents: 500, offer_code_id: null }],
      tips: [{ purchase_id: 11, value_cents: 50 }],
    });

    const reading = (await commissionReadings([deposit])).get("10")!;

    expect(reading.filesAreEditable).toBe(false);
    expect(reading.completion).toEqual({ displayedCents: 500, beforeOfferCode: 500, tipCents: 50 });
  });

  it("leaves a failed completion out of the row but still locks the files", async () => {
    answering({
      [asDeposit]: [{ ...commission, completion_purchase_id: 11 }],
      purchases: [{ id: 11, purchase_state: "failed", displayed_price_cents: 500 }],
    });

    const reading = (await commissionReadings([deposit])).get("10")!;

    expect(reading).toMatchObject({ filesAreEditable: false, completion: null });
  });

  it("reads a completion purchase's own commission without folding", async () => {
    answering({
      "commissions:completion_purchase_id": [{ ...commission, completion_purchase_id: 11, status: "completed" }],
    });

    const readings = await commissionReadings([{ id: 11, flags: COMPLETION }]);

    expect(readings.get("11")).toMatchObject({ status: "completed", completion: null });
  });

  const inProgressCompletion = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    purchase_state: "in_progress",
    stripe_transaction_id: null,
    processor_payment_intent_id: null,
    ...overrides,
  });

  it("leaves an unsettled in-progress completion unfolded when it has no processor reference", async () => {
    answering({
      [asDeposit]: [{ ...commission, completion_purchase_id: 11 }],
      purchases: [inProgressCompletion()],
    });

    const readings = await commissionReadings([deposit]);

    expect(readings.get("10")).toMatchObject({ completion: null });
  });

  it.each([
    ["a Stripe transaction id", { stripe_transaction_id: "ch_1" }],
    ["a payment intent id", { processor_payment_intent_id: "pi_1" }],
  ])("hands back an in-progress completion with %s", async (_label, overrides) => {
    answering({
      [asDeposit]: [{ ...commission, completion_purchase_id: 11 }],
      purchases: [inProgressCompletion(overrides)],
    });
    await expect(commissionReadings([deposit])).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back an in-progress completion that belongs to a charge", async () => {
    answering({
      [asDeposit]: [{ ...commission, completion_purchase_id: 11 }],
      purchases: [inProgressCompletion()],
      charge_purchases: [{ purchase_id: 11, charge_id: 4 }],
    });
    await expect(commissionReadings([deposit])).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lists the pending video before the approved one and skips rejected ones", async () => {
    answering({
      product_review_videos: [
        { id: 1, product_review_id: 7, approval_status: "approved" },
        { id: 2, product_review_id: 7, approval_status: "pending_review" },
      ],
      video_files: [
        { id: 20, record_id: 1 },
        { id: 21, record_id: 2 },
      ],
    });

    const shown = await shownReviewVideos([7]);

    expect(shown.get("7")!.map((video) => video.id)).toEqual([2, 1]);
  });
});

describe("Purchase#utm_link", () => {
  const seller = { id: 7n, username: "seller1" } as never;
  const utmLink = (overrides: Record<string, unknown> = {}) => ({
    id: 3,
    seller_id: 7,
    title: "Launch",
    target_resource_type: "profile_page",
    target_resource_id: null,
    utm_source: "news letter",
    utm_medium: "email",
    utm_campaign: "Spring&Sale",
    utm_term: null,
    utm_content: "",
    ...overrides,
  });

  function answering(driven: Record<string, unknown>[], links: Record<string, unknown>[]) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        if (query.sql.includes("FROM `utm_link_driven_sales`")) return driven;
        if (query.sql.includes("FROM `utm_links`")) return links;
        throw new Error(`unexpected statement: ${query.sql}`);
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }

  it("renders the link with a sorted, percent-encoded utm_url, leaving out blank term and content", async () => {
    answering([{ purchase_id: 5, utm_link_id: 3 }], [utmLink()]);

    const readings = await utmLinkReadings([5, 6], seller);

    expect(readings.size).toBe(1);
    expect(readings.get("5")).toEqual({
      title: "Launch",
      utm_url: "http://seller1.localhost:3000?utm_campaign=Spring%26Sale&utm_medium=email&utm_source=news%20letter",
      source: "news letter",
      medium: "email",
      campaign: "Spring&Sale",
      term: null,
      content: "",
    });
  });

  it("hands back a purchase driven through several visits, a vanished link, and another seller's link", async () => {
    answering(
      [
        { purchase_id: 5, utm_link_id: 3 },
        { purchase_id: 5, utm_link_id: 3 },
      ],
      [utmLink()],
    );
    await expect(utmLinkReadings([5], seller)).rejects.toThrow(HandBackToRails);

    answering([{ purchase_id: 5, utm_link_id: 3 }], []);
    await expect(utmLinkReadings([5], seller)).rejects.toThrow(HandBackToRails);

    answering([{ purchase_id: 5, utm_link_id: 3 }], [utmLink({ seller_id: 8 })]);
    await expect(utmLinkReadings([5], seller)).rejects.toThrow(HandBackToRails);
  });
});

describe("commission files and review video thumbnails", () => {
  function answering(tables: Record<string, Record<string, unknown>[]>) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        for (const [name, rows] of Object.entries(tables)) if (query.sql.includes(`FROM \`${name}\``)) return rows;
        return [];
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }

  it("lists a commission's files with their signed ids, in attachment order", async () => {
    process.env.SECRET_KEY_BASE = "customers-test-secret";
    answering({
      commissions: [{ id: 3, deposit_purchase_id: 10, completion_purchase_id: null, status: "in_progress" }],
      active_storage_attachments: [
        { record_id: 3, blob_id: 5, key: "k1", filename: "Mockup v2.PNG", byte_size: 2048 },
        { record_id: 3, blob_id: 6, key: "k2", filename: "notes.txt", byte_size: 10 },
      ],
    });

    const reading = (await commissionReadings([{ id: 10, flags: 1n << 28n }])).get("10")!;

    expect(reading.files.map(({ name, size, extension, key }) => ({ name, size, extension, key }))).toEqual([
      { name: "Mockup v2", size: 2048, extension: "PNG", key: "k1" },
      { name: "notes", size: 10, extension: "TXT", key: "k2" },
    ]);
    expect(reading.files[0]!.id).toMatch(/^[^-]+--[0-9a-f]{40}$/u);
    expect(reading.files[0]!.id).not.toBe(reading.files[1]!.id);
  });

  it("reads a commission without files as an empty list", async () => {
    answering({ commissions: [{ id: 3, deposit_purchase_id: 10, completion_purchase_id: null, status: "completed" }] });

    expect((await commissionReadings([{ id: 10, flags: 1n << 28n }])).get("10")!.files).toEqual([]);
  });

  it("puts the video file's thumbnail url on the video", async () => {
    videoThumbnail.mockResolvedValueOnce("https://cdn.example.com/thumb.png");
    answering({
      product_review_videos: [{ id: 1, product_review_id: 7, approval_status: "approved" }],
      video_files: [{ id: 20, record_id: 1 }],
    });

    const shown = await shownReviewVideos([7]);

    expect(videoThumbnail).toHaveBeenCalledWith(20);
    expect(shown.get("7")![0]!.thumbnail_url).toBe("https://cdn.example.com/thumb.png");
  });

  it("hands back a video whose thumbnail variant Rails has not processed", async () => {
    const { NotPortedError } = await import("../not-ported.ts");
    videoThumbnail.mockRejectedValueOnce(new NotPortedError("Generating a thumbnail variant"));
    answering({
      product_review_videos: [{ id: 1, product_review_id: 7, approval_status: "approved" }],
      video_files: [{ id: 20, record_id: 1 }],
    });

    await expect(shownReviewVideos([7])).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Subscription#future_subscription_charge? with the pre-discount price", () => {
  const preDiscount = (cents: number | null) => vi.fn(async () => cents);

  it("is false once the fixed number of charges is done, and true while the renewal price is positive", async () => {
    const read = preDiscount(900);
    expect(await futureSubscriptionCharge(true, 500, true, read)).toBe(false);
    expect(await futureSubscriptionCharge(false, 500, true, read)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("is false for a free renewal without a limited-cycle discount", async () => {
    const read = preDiscount(900);
    expect(await futureSubscriptionCharge(false, 0, false, read)).toBe(false);
    expect(await futureSubscriptionCharge(false, null, false, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("is true for a free renewal under a limited-cycle discount when the pre-discount price is positive", async () => {
    expect(await futureSubscriptionCharge(false, 0, true, preDiscount(900))).toBe(true);
    expect(await futureSubscriptionCharge(false, 0, true, preDiscount(0))).toBe(false);
  });

  it("hands back when there is no pre-discount price to compare", async () => {
    await expect(futureSubscriptionCharge(false, 0, true, preDiscount(null))).rejects.toThrow(HandBackToRails);
  });
});

describe("Purchase#variant_content_permits_license_key? of a gift's recipient", () => {
  const gifts = new Map([["1", { giftee_purchase_id: 2 }]]);
  const LICENSED = 1n << 6n;
  const PHYSICAL = 1n << 7n;
  const SAME_CONTENT = 1n << 24n;
  const base = {
    licenses: [{ id: 7, purchase_id: 2, serial: "KEY-1" }],
    purchases: [{ id: 2, link_id: 3 }],
    base_variants_purchases: [{ id: 1, purchase_id: 2, base_variant_id: 4 }],
  };
  const keyNode = [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "licenseKey" }] }] }];
  const textOnly = [{ type: "paragraph", content: [{ type: "text", text: "Welcome" }] }];

  // `FROM base_variants INNER JOIN variant_categories` must win over the plain `base_variants_purchases` match
  const withVariants = (extra: Record<string, Record<string, unknown>[]>) => ({
    ...extra,
    base_variants: [{ id: 4, link_id: 3 }],
  });

  it("keeps the key when the chosen option has no pages of its own", async () => {
    answeringTables(withVariants({ ...base, links: [{ id: 3, flags: LICENSED }], rich_contents: [] }));
    expect((await gifteeLicensesOf(gifts)).get("1")).toMatchObject({ serial: "KEY-1" });
  });

  it("keeps the key when the chosen option's page embeds a license key, even inside a list", async () => {
    answeringTables(
      withVariants({
        ...base,
        links: [{ id: 3, flags: LICENSED }],
        rich_contents: [{ id: 1, entity_id: 4, title: null, description: JSON.stringify(keyNode) }],
      }),
    );
    expect((await gifteeLicensesOf(gifts)).get("1")).toMatchObject({ serial: "KEY-1" });
  });

  it("gives no key when the chosen option's pages leave the license-key block out", async () => {
    answeringTables(
      withVariants({
        ...base,
        links: [{ id: 3, flags: LICENSED }],
        rich_contents: [{ id: 1, entity_id: 4, title: null, description: textOnly }],
      }),
    );
    expect((await gifteeLicensesOf(gifts)).size).toBe(0);
  });

  it("keeps the key for a physical product whatever the option's pages say", async () => {
    answeringTables(
      withVariants({
        ...base,
        links: [{ id: 3, flags: LICENSED | PHYSICAL }],
        rich_contents: [{ id: 1, entity_id: 4, title: null, description: textOnly }],
      }),
    );
    expect((await gifteeLicensesOf(gifts)).get("1")).toMatchObject({ serial: "KEY-1" });
  });

  it("reads product-level content when every option shares it", async () => {
    answeringTables(
      withVariants({
        ...base,
        links: [{ id: 3, flags: LICENSED | SAME_CONTENT }],
        rich_contents: [{ id: 1, entity_id: 3, title: "Welcome", description: textOnly }],
      }),
    );
    expect((await gifteeLicensesOf(gifts)).get("1")).toMatchObject({ serial: "KEY-1" });
  });
});
