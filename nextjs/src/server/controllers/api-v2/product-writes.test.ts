import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  updateBang: vi.fn(),
  offerCodes: vi.fn(),
  json: vi.fn(),
  findUnique: vi.fn(),
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
        16: "is_adult",
        17: "display_product_reviews",
        19: "is_tiered_membership",
        22: "should_show_sales_count",
      },
      { queryMode: "bit_operator" },
    ),
  };
});
vi.mock("./offer-codes.ts", () => ({ hasApplicableOfferCodes: mocks.offerCodes }));
vi.mock("./product-json.ts", () => ({ productsApiJson: mocks.json }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: vi.fn(), userActor: vi.fn() }));

const { registeredApiV2Routes } = await import("./base.ts");
await import("./product-writes.ts");

const update = registeredApiV2Routes().find((route) => route.method === "PUT" && route.pattern === "/v2/products/:id")!;
const draft = { id: 3n, name: "Pencil", flags: 0n, draft: true, deleted_at: null, purchase_disabled_at: null };
const run = (params: Record<string, unknown>, product: object = draft) =>
  update.run({ params, owner: { id: 7n }, token: { scopes: "edit_products" }, state: { product } } as never);

beforeEach(() => {
  mocks.updateBang.mockReset();
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

  it("saves a request with no attributes without changing any", async () => {
    await run({});
    expect(mocks.updateBang.mock.calls[0]![1]).toEqual({ flags: 0n });
  });

  it.each([
    ["a price", { price: 300 }],
    ["a description", { description: "x" }],
    ["a taxonomy_id, even a blank one", { taxonomy_id: "" }],
    ["tags", { tags: ["a"] }],
    ["a name that is not text", { name: 5 }],
    ["a flag given as text", { is_adult: "true" }],
    ["a flag given as a number", { display_product_reviews: 1 }],
  ])("hands %s back before writing", async (_label, params) => {
    await expect(run(params)).rejects.toThrow();
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
