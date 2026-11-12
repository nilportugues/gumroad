import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  updateBang: vi.fn(),
  offerCodes: vi.fn(),
  json: vi.fn(),
  findUnique: vi.fn(),
  planPrice: vi.fn(),
  writePrice: vi.fn(),
  planTags: vi.fn(),
  saveTags: vi.fn(),
}));
vi.mock("../../../lib/db.ts", () => ({ db: { link: { findUnique: mocks.findUnique } } }));
vi.mock("../../models/link.ts", async () => {
  const { defineFlags } = await import("../../../lib/flags.ts");
  return {
    Links: { load: (row: object) => ({ row, errors: { fullMessages: () => [] } }), updateBang: mocks.updateBang },
    LinkFlags: defineFlags(
      "links",
      {
        1: "product_refund_policy_enabled",
        2: "is_recurring_billing",
        14: "quantity_enabled",
        16: "is_adult",
        17: "display_product_reviews",
        19: "is_tiered_membership",
        22: "should_show_sales_count",
      },
      { queryMode: "bit_operator" },
    ),
  };
});
vi.mock("../../models/runtime/transaction.ts", () => ({ transaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../../models/price-writes.ts", () => ({
  planBuyPriceWrite: mocks.planPrice,
  writeBuyPrice: mocks.writePrice,
  PRICE_TOO_LARGE: "Sorry, the price entered is too large.",
}));
vi.mock("../../models/product-tags.ts", () => ({ planTagChanges: mocks.planTags, saveTags: mocks.saveTags }));
vi.mock("./offer-codes.ts", () => ({ hasApplicableOfferCodes: mocks.offerCodes }));
vi.mock("./product-json.ts", () => ({ productsApiJson: mocks.json }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: vi.fn(), userActor: vi.fn() }));

const { registeredApiV2Routes } = await import("./base.ts");
await import("./product-writes.ts");

const update = registeredApiV2Routes().find((route) => route.method === "PUT" && route.pattern === "/v2/products/:id")!;
const draft = {
  id: 3n,
  name: "Pencil",
  description: "<p>Old</p>",
  flags: 0n,
  draft: true,
  deleted_at: null,
  purchase_disabled_at: null,
};
const run = (params: Record<string, unknown>, product: object = draft) =>
  update.run({ params, owner: { id: 7n }, token: { scopes: "edit_products" }, state: { product } } as never);

beforeEach(() => {
  mocks.updateBang.mockReset();
  mocks.planPrice.mockReset().mockResolvedValue({ cents: 300 });
  mocks.writePrice.mockReset();
  mocks.planTags.mockReset().mockResolvedValue([{ name: "ink", action: "add", tagId: null }]);
  mocks.saveTags.mockReset();
  mocks.offerCodes.mockReset().mockResolvedValue(false);
  mocks.json.mockReset().mockResolvedValue([{ name: "Pen" }]);
  mocks.findUnique.mockReset().mockResolvedValue({ ...draft, name: "Pen" });
});

describe("PUT /v2/products/:id with simple attributes", () => {
  it("renames a draft and sets the flags in one save", async () => {
    await run({ name: "Pen", is_adult: true, should_show_sales_count: true });
    expect(mocks.updateBang).toHaveBeenCalledTimes(1);
    expect(mocks.updateBang.mock.calls[0]![1]).toEqual({ flags: (1n << 15n) | (1n << 21n), name: "Pen" });
  });

  it("assigns the columns of the other attributes with the product", async () => {
    await run({
      customizable_price: true,
      suggested_price_cents: "900",
      max_purchase_count: null,
      quantity_enabled: true,
      taxonomy_id: "",
      custom_receipt: "Thanks",
    });
    expect(mocks.updateBang.mock.calls[0]![1]).toEqual({
      flags: 1n << 13n,
      customizable_price: true,
      suggested_price_cents: 900,
      max_purchase_count: null,
      taxonomy_id: null,
      custom_receipt: "Thanks",
    });
  });

  it("saves a request with no attributes without changing any", async () => {
    await run({});
    expect(mocks.updateBang.mock.calls[0]![1]).toEqual({ flags: 0n });
  });

  it.each([
    ["a taxonomy_id that is a list", { taxonomy_id: [1] }],
    ["a custom_summary that is a list", { custom_summary: ["a"] }],
    ["a custom_receipt that is a hash", { custom_receipt: { a: 1 } }],
    ["a customizable_price given as text", { customizable_price: "true" }],
    ["a suggested_price_cents with a fraction", { suggested_price_cents: "8.5" }],
    ["a max_purchase_count outside the integer range", { max_purchase_count: 3_000_000_000 }],
    ["a custom_permalink", { custom_permalink: "pen" }],
    ["a description that is not text", { description: 5 }],
    ["a description that holds markup Nokogiri rewrites", { description: "<ul><li>a</li></ul>" }],
    ["a name that is not text", { name: 5 }],
    ["a flag given as text", { is_adult: "true" }],
    ["a flag given as a number", { display_product_reviews: 1 }],
  ])("hands %s back before writing", async (_label, params) => {
    await expect(run(params)).rejects.toThrow();
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("saves the price, then the product, then the tags, in one transaction", async () => {
    const calls: string[] = [];
    mocks.writePrice.mockImplementation(() => void calls.push("price"));
    mocks.updateBang.mockImplementation(() => void calls.push("product"));
    mocks.saveTags.mockImplementation(() => void calls.push("tags"));

    await run({ name: "Pen", price: 300, tags: ["ink"], description: "<p>Writes</p>" });

    expect(calls).toEqual(["price", "product", "tags"]);
    expect(mocks.writePrice).toHaveBeenCalledWith(draft, 300);
    expect(mocks.updateBang.mock.calls[0]![1]).toEqual({ flags: 0n, name: "Pen", description: "<p>Writes</p>" });
  });

  it("answers a price past the column without writing", async () => {
    mocks.planPrice.mockResolvedValue({ tooLarge: true });

    const result = await run({ price: 2_147_483_648 });

    expect(JSON.stringify(result)).toContain("Sorry, the price entered is too large.");
    expect(mocks.writePrice).not.toHaveBeenCalled();
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("plans the tags and the price before the first write", async () => {
    mocks.planTags.mockRejectedValue(new Error("a tag name that is not plain"));

    await expect(run({ price: 300, tags: ["Ink"] })).rejects.toThrow("not plain");
    expect(mocks.writePrice).not.toHaveBeenCalled();
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("hands a description over one with upsell cards back", async () => {
    await expect(
      run({ description: "<p>x</p>" }, { ...draft, description: '<upsell-card id="a"></upsell-card>' }),
    ).rejects.toThrow("upsell cards");
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("hands the description change of a published product back, because moderation is Ruby's", async () => {
    await expect(run({ description: "<p>x</p>" }, { ...draft, draft: false, description: "<p>y</p>" })).rejects.toThrow(
      "published product",
    );
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("hands the rename of a published product back, because moderation is Ruby's", async () => {
    await expect(run({ name: "Pen" }, { ...draft, draft: false })).rejects.toThrow("published product");
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });

  it("saves a published product when the name is the one it has", async () => {
    await run({ name: "Pencil" }, { ...draft, draft: false });
    expect(mocks.updateBang).toHaveBeenCalledTimes(1);
  });

  it("hands a product with offer codes back, because their validity is checked after the save", async () => {
    mocks.offerCodes.mockResolvedValue(true);
    await expect(run({ name: "Pen" })).rejects.toThrow("offer codes");
    expect(mocks.updateBang).not.toHaveBeenCalled();
  });
});
