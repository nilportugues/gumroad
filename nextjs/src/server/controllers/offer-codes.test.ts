// Vectors are the expectations of spec/controllers/offer_codes_controller_spec.rb (#compute_discount): the invalid,
// sold_out, partial (capped universal code), whitespace and missing-products examples, plus the hand-backs.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { HandBackToRails } from "./application-controller.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY = "offer-codes-test-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";

const { selectRows, quantityLeft, restrictedVariants, ownershipMonths, returningCustomer } = vi.hoisted(() => ({
  selectRows: vi.fn(),
  quantityLeft: vi.fn(),
  // Months since the signed-in buyer's oldest qualifying purchase; null when they own nothing.
  ownershipMonths: { value: null as number | null },
  returningCustomer: vi.fn(),
  restrictedVariants: [] as { id: number; productId: number }[],
}));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../presenters/best-offer-code.ts", () => ({
  star: () => "",
  normalizeCode: (code: string) => code.normalize("NFC").trim().toLowerCase(),
  asRecord: (row: Record<string, unknown>) => ({
    row,
    id: row.id,
    oncePerCart: row.oncePerCart === true,
    tiered: () => ((row.tiers as unknown[] | undefined) ?? []).length > 0,
    // A visitor owns nothing: months is nil, so only a month-0 tier matches.
    evaluateForBuyer: async (buyer: unknown) => {
      const months = buyer === null ? null : ownershipMonths.value;
      if (row.existing_customers_only && months === null) return null;
      const tiers = (row.tiers as { months: number; pct: number }[] | undefined) ?? [];
      if (tiers.length > 0) {
        const tier = tiers.filter((t) => t.months <= (months ?? 0)).at(-1);
        return tier ? { type: "percent", percents: tier.pct } : null;
      }
      return { type: "fixed", cents: 100 };
    },
    returningCustomer,
    inactive: (now: Date) => row.expires_at != null && (row.expires_at as Date).getTime() < now.getTime(),
    restrictedVariantsFor: async (product: { id: number }) =>
      restrictedVariants
        .filter((variant) => String(variant.productId) === String(product.id))
        .map((variant) => ({ row: { id: variant.id } })),
    quantityLeft,
  }),
  applicable: async () => true,
  currencyValid: () => true,
  fullDiscount: async (code: { row: { id: number; amount_cents: number; oncePerCart?: boolean } }) => ({
    type: "fixed",
    cents: code.row.amount_cents,
    product_ids: [`p${code.row.id}`],
    ...(code.row.oncePerCart ? { once_per_cart: true, once_per_cart_amount_cents: code.row.amount_cents } : {}),
  }),
}));

const { computeDiscount, cartLines } = await import("./offer-codes.ts");
const { parseQuery } = await import("./rails-query.ts");

const NOW = new Date("2026-01-01T00:00:00Z");
const link = (id: number) => ({
  id,
  user_id: 1,
  unique_permalink: `perm${id}`,
  deleted_at: null,
  price_currency_type: "usd",
  price_cents: 500,
});
const code = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  user_id: 1,
  code: "off",
  expires_at: null,
  minimum_quantity: null,
  max_purchase_count: null,
  existing_customers_only: false,
  new_customers_only: false,
  amount_cents: 100,
  ...extra,
});
const req = (queryString: string) => ({ queryString }) as never;
const cartQuery = (permalinks: string[], quantity = 1) =>
  permalinks.map((p, i) => `products[${i}][permalink]=${p}&products[${i}][quantity]=${quantity}`).join("&");
const body = async (query: string, buyer: object | null = null) =>
  JSON.parse(((await computeDiscount(req(query), buyer as never, NOW)) as { body: string }).body);

// Calls in order: visible links, the user's codes, then the cross-sell probe per applicable line.
function stubDb({ links = [link(1)], codes = [code()], crossSells = false } = {}) {
  selectRows.mockImplementation(async (query: { sql: string }) => {
    if (query.sql.includes("FROM `links`")) return links;
    if (query.sql.includes("FROM `offer_codes`")) return codes;
    if (query.sql.includes("FROM `upsells`")) return crossSells ? [{ one: 1 }] : [];
    return [];
  });
}

beforeEach(() => {
  selectRows.mockReset();
  quantityLeft.mockReset();
  restrictedVariants.length = 0;
  ownershipMonths.value = null;
  returningCustomer.mockReset();
});

describe("cartLines (OfferCodesController#product_params)", () => {
  it("reads a nested, repeated or non-hash line as absent", () => {
    expect(cartLines(parseQuery("products[0][permalink][0]=a&products[0][quantity]=2"))).toEqual({
      "0": { quantity: "2" },
    });
    expect(cartLines(parseQuery("products[0]=abc"))).toEqual({});
    expect(cartLines(parseQuery("products[]=abc"))).toEqual({});
    expect(cartLines(parseQuery("code=x"))).toEqual({});
  });
});

describe("GET /offer_codes/compute_discount", () => {
  it("returns an invalid_offer error for an unknown code", async () => {
    stubDb({ codes: [] });
    expect(await body(`code=invalid_offer&${cartQuery(["perm1"])}`)).toEqual({
      valid: false,
      error_code: "invalid_offer",
      error_message: "Sorry, the discount code you wish to use is invalid.",
    });
  });

  it("returns invalid_offer when the products param is missing", async () => {
    stubDb({ links: [], codes: [] });
    expect(await body("code=off")).toEqual({
      valid: false,
      error_code: "invalid_offer",
      error_message: "Sorry, the discount code you wish to use is invalid.",
    });
  });

  it("reads a line that is not a hash as absent and answers invalid_offer", async () => {
    stubDb({ links: [], codes: [] });
    expect((await body("code=off&products[0]=abc")).error_code).toBe("invalid_offer");
  });

  it("applies a code pasted with leading whitespace", async () => {
    stubDb();
    const result = await body(`code=%20Off&${cartQuery(["perm1"])}`);
    expect(result.valid).toBe(true);
    expect(Object.keys(result.products_data)).toEqual(["perm1"]);
    expect(selectRows.mock.calls.some(([q]) => (q.values as unknown[]).includes("off"))).toBe(true);
  });

  it("returns the products data of a valid code", async () => {
    stubDb();
    expect(await body(`code=off&${cartQuery(["perm1"], 2)}`)).toEqual({
      valid: true,
      products_data: { perm1: { type: "fixed", cents: 100, product_ids: ["p7"] } },
    });
  });

  it("returns sold_out when the code has no uses left", async () => {
    stubDb({ codes: [code({ max_purchase_count: 0 })] });
    quantityLeft.mockResolvedValue(0);
    expect(await body(`code=off&${cartQuery(["perm1"], 2)}`)).toEqual({
      valid: false,
      error_code: "sold_out",
      error_message: "Sorry, the discount code you wish to use has reached its usage limit.",
    });
  });

  it("returns insufficient_times_of_use when some uses are left but fewer than the quantity", async () => {
    stubDb({ codes: [code({ max_purchase_count: 2 })] });
    quantityLeft.mockResolvedValue(1);
    expect((await body(`code=off&${cartQuery(["perm1"], 2)}`)).error_code).toBe("insufficient_times_of_use");
  });

  it("returns inactive for an expired code", async () => {
    stubDb({ codes: [code({ expires_at: new Date("2025-12-31T00:00:00Z") })] });
    expect((await body(`code=off&${cartQuery(["perm1"])}`)).error_code).toBe("inactive");
  });

  it("returns unmet_minimum_purchase_quantity below the minimum", async () => {
    stubDb({ codes: [code({ minimum_quantity: 3 })] });
    expect((await body(`code=off&${cartQuery(["perm1"], 2)}`)).error_code).toBe("unmet_minimum_purchase_quantity");
  });

  it("discounts the lines that fit a capped code and explains why the rest are excluded", async () => {
    stubDb({ links: [link(1), link(2), link(3)], codes: [code({ max_purchase_count: 2 })] });
    quantityLeft.mockResolvedValue(2);
    const result = await body(`code=off&${cartQuery(["perm1", "perm2", "perm3"])}`);
    expect(Object.keys(result.products_data)).toEqual(["perm1", "perm2"]);
    expect(result.notice).toBe(
      "The discount code was applied to some products. The rest exceed its remaining usage limit.",
    );
  });

  it("rejects the whole cart only when no line fits", async () => {
    stubDb({ links: [link(1), link(2)], codes: [code({ max_purchase_count: 0 })] });
    quantityLeft.mockResolvedValue(0);
    expect((await body(`code=off&${cartQuery(["perm1", "perm2"])}`)).error_code).toBe("sold_out");
  });

  it("omits the notice when the code covers the whole cart", async () => {
    stubDb({ links: [link(1), link(2), link(3)], codes: [code({ max_purchase_count: 3 })] });
    quantityLeft.mockResolvedValue(3);
    const result = await body(`code=off&${cartQuery(["perm1", "perm2", "perm3"])}`);
    expect(Object.keys(result.products_data)).toHaveLength(3);
    expect(result).not.toHaveProperty("notice");
  });
});

describe("a code limited to options (entries_eligible_for_option_scope)", () => {
  const optionLine = (index: number, permalink: string, option: string | null, quantity = 1) =>
    `products[${index}][permalink]=${permalink}&products[${index}][quantity]=${quantity}${
      option === null ? "" : `&products[${index}][variant_external_id]=${option}`
    }`;
  const inScope = encrypt(31);

  beforeEach(() => restrictedVariants.push({ id: 31, productId: 1 }));

  it("discounts a line that picks an option the code covers", async () => {
    stubDb();
    expect(Object.keys((await body(`code=off&${optionLine(0, "perm1", inScope)}`)).products_data)).toEqual(["perm1"]);
  });

  it("keeps a line that omits the option, as the product page preview does", async () => {
    stubDb();
    expect((await body(`code=off&${optionLine(0, "perm1", null)}`)).valid).toBe(true);
  });

  it("answers option_not_eligible when the only line picks another option", async () => {
    stubDb();
    expect(await body(`code=off&${optionLine(0, "perm1", encrypt(32))}`)).toEqual({
      valid: false,
      error_code: "option_not_eligible",
      error_message: "This code does not apply to the selected option.",
    });
  });

  it("treats a blank option as out of scope", async () => {
    stubDb();
    expect((await body(`code=off&${optionLine(0, "perm1", "")}`)).error_code).toBe("option_not_eligible");
  });

  it("counts only the covered lines toward the minimum quantity and explains the rest", async () => {
    stubDb({ codes: [code({ minimum_quantity: 2 })] });
    const query = `${optionLine(0, "perm1", inScope, 2)}&${optionLine(1, "perm1", encrypt(32), 5)}`;
    const result = await body(`code=off&${query}`);
    expect(Object.keys(result.products_data)).toEqual(["perm1"]);
    expect(result.notice).toBe(
      "The code applies to some items. The selected options for the other items are not eligible.",
    );
    expect(
      (await body(`code=off&${optionLine(0, "perm1", inScope, 1)}&${optionLine(1, "perm1", encrypt(32), 5)}`))
        .error_code,
    ).toBe("unmet_minimum_purchase_quantity");
  });

  it("does not limit a product the code has no options for", async () => {
    stubDb({ links: [link(1), link(2)] });
    const result = await body(`code=off&${optionLine(0, "perm1", encrypt(32))}&${optionLine(1, "perm2", encrypt(32))}`);
    expect(Object.keys(result.products_data)).toEqual(["perm2"]);
    expect(result.notice).toContain("The code applies to some items");
  });
});

describe("compute_discount hand-backs", () => {
  it("answers a new-customers code for a visitor, who has no purchase history", async () => {
    stubDb({ codes: [code({ new_customers_only: true })] });
    expect((await body(`code=off&${cartQuery(["perm1"])}`)).valid).toBe(true);
  });

  it("answers an existing-customers code for a visitor with not_existing_customer", async () => {
    stubDb({ codes: [code({ existing_customers_only: true })] });
    expect(await body(`code=off&${cartQuery(["perm1"])}`)).toEqual({
      valid: false,
      error_code: "not_existing_customer",
      error_message: "Sorry, this discount code is only for existing customers.",
    });
  });

  it("gives a visitor the month-0 tier of a tiered code over the configured discount", async () => {
    stubDb({
      codes: [
        code({
          tiers: [
            { months: 0, pct: 15 },
            { months: 6, pct: 30 },
          ],
        }),
      ],
    });
    expect((await body(`code=off&${cartQuery(["perm1"])}`)).products_data.perm1).toMatchObject({
      type: "percent",
      percents: 15,
    });
  });

  it("hands back a seller with cross-sells and a non-scalar code", async () => {
    stubDb({ crossSells: true });
    await expect(body(`code=off&${cartQuery(["perm1"])}`)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(body("code[]=off")).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("a once-per-cart fixed code (allocate_once_per_cart_discount)", () => {
  const perCart = (extra: Record<string, unknown> = {}) => code({ oncePerCart: true, amount_cents: 300, ...extra });
  const centsOf = (result: { products_data: Record<string, { cents: number }> }) =>
    Object.values(result.products_data).map((discount) => discount.cents);

  it("shares the fixed amount across the lines in cart order", async () => {
    stubDb({ links: [link(1), link(2)], codes: [perCart()] });
    const result = await body(`code=off&${cartQuery(["perm1", "perm2"])}`);
    expect(centsOf(result)).toEqual([300, 0]);
    expect(result.products_data.perm1).toMatchObject({ once_per_cart: true, once_per_cart_amount_cents: 300 });
  });

  it("carries the remainder of a line that cannot absorb the whole amount", async () => {
    stubDb({ links: [link(1), link(2)], codes: [perCart({ amount_cents: 700 })] });
    expect(centsOf(await body(`code=off&${cartQuery(["perm1", "perm2"])}`))).toEqual([500, 200]);
  });

  it("keeps the price after the discount at the currency minimum", async () => {
    stubDb({ codes: [perCart({ amount_cents: 450 })] });
    expect(centsOf(await body(`code=off&${cartQuery(["perm1"])}`))).toEqual([401]);
  });

  it("allocates against the submitted price less the tip", async () => {
    stubDb({ codes: [perCart({ amount_cents: 1000 })] });
    const query =
      "code=off&products[0][permalink]=perm1&products[0][quantity]=1&products[0][price_cents]=900&products[0][tip_cents]=100";
    expect(centsOf(await body(query))).toEqual([800]);
  });

  it("falls back to the product price times quantity when a submitted price is not an integer", async () => {
    stubDb({ codes: [perCart({ amount_cents: 5000 })] });
    const query = "code=off&products[0][permalink]=perm1&products[0][quantity]=2&products[0][price_cents]=abc";
    expect(centsOf(await body(query))).toEqual([1000]);
  });

  it("sums the lines of one permalink before allocating", async () => {
    stubDb({ codes: [perCart({ amount_cents: 5000 })] });
    const query =
      "code=off&products[0][permalink]=perm1&products[0][quantity]=1&products[0][price_cents]=0x10&products[1][permalink]=perm1&products[1][quantity]=2&products[1][price_cents]=1_000";
    expect(centsOf(await body(query))).toEqual([1016]);
  });

  it("spends one use however many units the line holds", async () => {
    stubDb({ codes: [perCart({ max_purchase_count: 1 })] });
    quantityLeft.mockResolvedValue(1);
    expect(centsOf(await body(`code=off&${cartQuery(["perm1"], 5)}`))).toEqual([300]);
  });

  it("covers a later line of a spent capped code without spending another use", async () => {
    stubDb({ links: [link(1), link(2)], codes: [perCart({ max_purchase_count: 1 })] });
    quantityLeft.mockResolvedValue(1);
    const result = await body(`code=off&${cartQuery(["perm1", "perm2"])}`);
    expect(Object.keys(result.products_data)).toEqual(["perm1", "perm2"]);
    expect(result).not.toHaveProperty("notice");
  });

  it("answers sold_out when the code has no uses left", async () => {
    stubDb({ codes: [perCart({ max_purchase_count: 0 })] });
    quantityLeft.mockResolvedValue(0);
    expect((await body(`code=off&${cartQuery(["perm1"])}`)).error_code).toBe("sold_out");
  });

  it("drops a later line that misses the minimum quantity and explains it", async () => {
    stubDb({ links: [link(1), link(2)], codes: [perCart({ minimum_quantity: 2 })] });
    const query =
      "code=off&products[0][permalink]=perm1&products[0][quantity]=2&products[1][permalink]=perm2&products[1][quantity]=1";
    const result = await body(query);
    expect(Object.keys(result.products_data)).toEqual(["perm1"]);
    expect(result.notice).toContain("minimum quantity");
  });

  it("leaves a percent code alone", async () => {
    stubDb({ codes: [perCart({ amount_cents: null, amount_percentage: 10 })] });
    expect(Object.values((await body(`code=off&${cartQuery(["perm1"])}`)).products_data)).toHaveLength(1);
  });
});

describe("compute_discount for a signed-in buyer", () => {
  const buyer = { id: 5n, email: "buyer@example.com" };
  const url = `code=off&${cartQuery(["perm1"])}`;
  const tiers = [
    { months: 0, pct: 10 },
    { months: 12, pct: 50 },
  ];

  it("gives an existing-customers code to a buyer who owns the product", async () => {
    stubDb({ codes: [code({ existing_customers_only: true })] });
    ownershipMonths.value = 3;
    expect((await body(url, buyer)).valid).toBe(true);
  });

  it("answers not_existing_customer when the buyer owns nothing", async () => {
    stubDb({ codes: [code({ existing_customers_only: true })] });
    expect((await body(url, buyer)).error_code).toBe("not_existing_customer");
  });

  it("gives a tiered code the tier the buyer's ownership has reached", async () => {
    stubDb({ codes: [code({ tiers })] });
    ownershipMonths.value = 14;
    expect((await body(url, buyer)).products_data.perm1).toMatchObject({ type: "percent", percents: 50 });
    ownershipMonths.value = 2;
    expect((await body(url, buyer)).products_data.perm1).toMatchObject({ type: "percent", percents: 10 });
  });

  it("gives a new-customers code to a buyer with no earlier purchase from the seller", async () => {
    stubDb({ codes: [code({ new_customers_only: true })] });
    returningCustomer.mockResolvedValue(false);
    expect((await body(url, buyer)).valid).toBe(true);
    expect(returningCustomer).toHaveBeenCalledWith([5n], ["buyer@example.com"]);
  });

  it("answers not_new_customer for a buyer who has bought from the seller before", async () => {
    stubDb({ codes: [code({ new_customers_only: true })] });
    returningCustomer.mockResolvedValue(true);
    expect(await body(url, buyer)).toEqual({
      valid: false,
      error_code: "not_new_customer",
      error_message: "Sorry, this discount code is only for new customers.",
    });
  });

  it("does not look up purchases for a visitor with a new-customers code", async () => {
    stubDb({ codes: [code({ new_customers_only: true })] });
    expect((await body(url)).valid).toBe(true);
    expect(returningCustomer).not.toHaveBeenCalled();
  });
});
