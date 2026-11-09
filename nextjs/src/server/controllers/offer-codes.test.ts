// Vectors are the expectations of spec/controllers/offer_codes_controller_spec.rb (#compute_discount): the invalid,
// sold_out, partial (capped universal code), whitespace and missing-products examples, plus the hand-backs.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";

const { selectRows, quantityLeft } = vi.hoisted(() => ({ selectRows: vi.fn(), quantityLeft: vi.fn() }));

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
    oncePerCart: false,
    tiered: () => false,
    inactive: (now: Date) => row.expires_at != null && (row.expires_at as Date).getTime() < now.getTime(),
    hasVariants: async () => false,
    quantityLeft,
  }),
  applicable: async () => true,
  currencyValid: () => true,
  fullDiscount: async (code: { row: { id: number } }) => ({
    type: "fixed",
    cents: 100,
    product_ids: [`p${code.row.id}`],
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
const body = async (query: string, signedIn = false) =>
  JSON.parse(((await computeDiscount(req(query), signedIn, NOW)) as { body: string }).body);

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

describe("compute_discount hand-backs", () => {
  it.each([
    ["an existing-customers code", { existing_customers_only: true }],
    ["a new-customers code for a signed-in buyer", { new_customers_only: true }],
  ])("hands back %s", async (_name, extra) => {
    stubDb({ codes: [code(extra)] });
    await expect(body(`code=off&${cartQuery(["perm1"])}`, true)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers a new-customers code for a visitor, who has no purchase history", async () => {
    stubDb({ codes: [code({ new_customers_only: true })] });
    expect((await body(`code=off&${cartQuery(["perm1"])}`)).valid).toBe(true);
  });

  it("hands back a seller with cross-sells and a non-scalar code", async () => {
    stubDb({ crossSells: true });
    await expect(body(`code=off&${cartQuery(["perm1"])}`)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(body("code[]=off")).rejects.toBeInstanceOf(HandBackToRails);
  });
});
