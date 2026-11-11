import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../../../lib/db.ts", () => ({ db: { assetPreview: { findFirst: mocks.findFirst } } }));

const { registeredApiV2Routes } = await import("./base.ts");
await import("./product-bundle-covers.ts");

const route = (method: string, pattern: string) =>
  registeredApiV2Routes().find((r) => r.method === method && r.pattern === pattern)!;
// flag_shih_tzu position 26 is bit 2^25.
const IS_BUNDLE = 1n << 25n;
const run = async (
  method: string,
  pattern: string,
  params: Record<string, unknown>,
  flags = IS_BUNDLE,
  routeParams = {},
) => route(method, pattern).run({ params, routeParams, state: { product: { id: 3n, flags } } } as never);
const message = async (promise: unknown) => JSON.parse(String(((await promise) as { body: string }).body)).message;

beforeEach(() => mocks.findFirst.mockReset());

describe("PUT /v2/products/:link_id/bundle_contents", () => {
  const update = (params: Record<string, unknown>, flags?: bigint) =>
    run("PUT", "/v2/products/:link_id/bundle_contents", params, flags);

  it("refuses a product that is not a bundle", async () => {
    expect(await message(update({ products: [] }, 0n))).toBe("This product is not a bundle.");
  });

  it("refuses a quantity that is not an integer from 1 to 2147483647", async () => {
    const quantity = "Quantity must be an integer greater than 0.";
    for (const value of ["abc", "", "0", "-1", 0, false, true, "2147483648"])
      expect(await message(update({ products: [{ product_id: "p", quantity: value }] }))).toBe(quantity);
  });

  it("refuses a position that is present and not a valid integer", async () => {
    const position = "Position must be a valid integer.";
    for (const value of ["x", true, "2147483648"])
      expect(await message(update({ products: [{ product_id: "p", position: value }] }))).toBe(position);
  });

  it("reports the first entry that fails", async () => {
    const products = [{ quantity: 1 }, { quantity: 0 }, { quantity: 1, position: "x" }];
    expect(await message(update({ products }))).toBe("Quantity must be an integer greater than 0.");
  });

  it("hands a valid replacement back to Rails", async () => {
    const valid = [[], [{ product_id: "p" }], [{ product_id: "p", quantity: " 3 ", position: -1 }]];
    for (const products of [...valid, [{ quantity: null, position: " " }]])
      await expect(update({ products })).rejects.toThrow("replacing the contents");
  });

  it("hands back what Ruby may read differently", async () => {
    await expect(update({})).rejects.toThrow("not a list of hashes");
    await expect(update({ products: "x" })).rejects.toThrow("not a list of hashes");
    await expect(update({ products: ["x"] })).rejects.toThrow("not a list of hashes");
    await expect(update({ products: [{ quantity: "0x10" }] })).rejects.toThrow("prefix or underscores");
    await expect(update({ products: [{ quantity: " 1x" }] })).rejects.toThrow("prefix or underscores");
    await expect(update({ products: [{ quantity: 1.5 }] })).rejects.toThrow("safe whole number");
    await expect(update({ products: [{ quantity: [1] }] })).rejects.toThrow("not a scalar");
  });
});

describe("POST /v2/products/:link_id/covers", () => {
  const create = (params: Record<string, unknown>) => run("POST", "/v2/products/:link_id/covers", params);

  it("asks for a signed_blob_id or url", async () => {
    for (const params of [{}, { url: " " }, { signed_blob_id: "", url: null }, { signed_blob_id: {} }])
      expect(await message(create(params))).toBe("Please provide a signed_blob_id or url.");
  });

  it("refuses a signed_blob_id that is not text", async () => {
    for (const signed_blob_id of [5, true, ["x"], { a: 1 }])
      expect(await message(create({ signed_blob_id }))).toBe("The signed_blob_id is invalid or expired.");
  });

  it("hands a blob or url back to Rails", async () => {
    await expect(create({ signed_blob_id: "abc" })).rejects.toThrow("attaching a cover");
    await expect(create({ url: "https://example.com/a.png" })).rejects.toThrow("attaching a cover");
  });
});

describe("DELETE /v2/products/:link_id/covers/:id", () => {
  const destroy = () => run("DELETE", "/v2/products/:link_id/covers/:id", {}, 0n, { id: "guid" });

  it("says the cover was not found when no live cover of the product has the guid", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await message(destroy())).toBe("The cover was not found.");
    expect(mocks.findFirst.mock.calls[0]![0].where).toEqual({ link_id: 3n, deleted_at: null, guid: "guid" });
  });

  it("hands the delete of a live cover back to Rails", async () => {
    mocks.findFirst.mockResolvedValue({ id: 1n });
    await expect(destroy()).rejects.toThrow("deleting a cover");
  });
});

describe("PUT /v2/products/:id/enable", () => {
  it("hands the publish back to Rails", async () => {
    await expect(run("PUT", "/v2/products/:id/enable", {})).rejects.toThrow("publishing a product");
  });
});
