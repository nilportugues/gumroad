import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({ createApiLink: vi.fn() }));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));
vi.mock("../../models/link-create.ts", () => ({ createApiLink: mocks.createApiLink }));
vi.mock("../../models/runtime/transaction.ts", () => ({ transaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: vi.fn(), userActor: vi.fn() }));

const { registeredApiV2Routes } = await import("./base.ts");
await import("./product-writes.ts");

const create = registeredApiV2Routes().find((route) => route.method === "POST" && route.pattern === "/v2/products")!;
const run = (params: Record<string, unknown>) =>
  create.run({
    params: { name: "Notebook", draft: true, ...params },
    owner: { id: 7n, flags: 0n, currency_type: "usd" },
    token: { scopes: "edit_products" },
    request: new Request("https://api.example.com/v2/products", { method: "POST" }),
    state: {},
  } as never);

const createdWith = () => mocks.createApiLink.mock.calls[0]![1] as Record<string, unknown>;

beforeEach(() => {
  mocks.createApiLink.mockReset().mockResolvedValue({ created: false, errors: { fullMessages: () => ["refused"] } });
});

describe("POST /v2/products price", () => {
  it("reads a null price as no price", async () => {
    await run({ price: null });
    expect(createdWith().priceCents).toBeNull();
  });

  it.each([
    ["5.50", 5],
    ["0.99", 0],
    ["1250.5", 1250],
  ])("reads the text %s as the cents before the point", async (price, cents) => {
    await run({ price });
    expect(createdWith().priceCents).toBe(cents);
  });

  it.each([["5."], [".5"], ["-5.5"], ["1e3"], ["5.5.5"], ["5,50"], [5.5], [true], [["5"]]])(
    "hands the price %j back",
    async (price) => {
      await expect(run({ price })).rejects.toThrow("price");
      expect(mocks.createApiLink).not.toHaveBeenCalled();
    },
  );
});

describe("POST /v2/products purchase limit", () => {
  it.each([
    [false, 0],
    [true, 1],
    [3_000_000_000, 3_000_000_000],
    ["7", 7],
  ])("passes %j on as %j for the model to clamp", async (limit, expected) => {
    await run({ price: 500, max_purchase_count: limit });
    expect(createdWith().maxPurchaseCount).toBe(expected);
  });

  it.each([["3000000000"], [-3_000_000_000]])("hands the limit %j back", async (limit) => {
    await expect(run({ price: 500, max_purchase_count: limit })).rejects.toThrow("max_purchase_count");
  });
});

describe("POST /v2/products customizable price", () => {
  it.each([
    ["true", true],
    ["0", false],
    [false, false],
  ])("reads %j as %j", async (value, expected) => {
    await run({ price: 500, customizable_price: value });
    expect(createdWith().customizablePrice).toBe(expected);
  });

  it("hands a spelling no recording holds back", async () => {
    await expect(run({ price: 500, customizable_price: "yes" })).rejects.toThrow("customizable_price");
  });
});
