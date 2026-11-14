import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rendered } from "../application-controller.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => {
  const tx = { variantCategory: { create: vi.fn(), update: vi.fn() }, link: { update: vi.fn() } };
  return { tx, db: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) } };
});
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("../../models/link.ts", () => ({ invalidateProductCache: vi.fn() }));
const variants = vi.hoisted(() => ({
  assertPlainVariantProduct: vi.fn(async () => undefined),
  assertPlainVariant: vi.fn(async () => undefined),
  Variants: { save: vi.fn(), withLock: vi.fn() },
  buildVariant: vi.fn((attributes: object) => ({ attributes })),
  loadVariantRecord: vi.fn(),
}));
vi.mock("../../models/variant-writes.ts", () => variants);

const { registeredApiV2Routes } = await import("./base.ts");
await import("./product-resource-writes.ts");

const route = (method: string, pattern: string) =>
  registeredApiV2Routes().find((candidate) => candidate.method === method && candidate.pattern === pattern)!;
const product = { id: 3n };
const category = {
  id: 9n,
  link_id: 3,
  title: "Size",
  deleted_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};
const run = (method: string, pattern: string, params: Record<string, unknown>, state: Record<string, unknown>) =>
  route(method, pattern).run({ params, state: { product, ...state } } as never) as Promise<Rendered>;
const created = () => mocks.tx.variantCategory.create.mock.calls[0]![0].data;

beforeEach(() => {
  mocks.tx.variantCategory.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: object }) => ({ ...category, ...data }));
  mocks.tx.variantCategory.update.mockReset();
  mocks.tx.link.update.mockReset();
});

describe("POST /v2/products/:link_id/variant_categories", () => {
  const create = (params: Record<string, unknown>) =>
    run("POST", "/v2/products/:link_id/variant_categories", params, {});

  it("stores a JSON true title as 1, the varchar cast Rails applies", async () => {
    await create({ title: true });
    expect(created()).toEqual({ link_id: 3, title: "1" });
  });

  it("stores a JSON false title as 0", async () => {
    await create({ title: false });
    expect(created()).toEqual({ link_id: 3, title: "0" });
  });

  it("keeps a string title as given", async () => {
    await create({ title: "Colour" });
    expect(created()).toEqual({ link_id: 3, title: "Colour" });
  });

  it("hands a title it cannot cast back to Rails before writing anything", async () => {
    await expect(create({ title: 5 })).rejects.toThrow("a variant category title that is not a string");
    expect(mocks.tx.variantCategory.create).not.toHaveBeenCalled();
  });
});

describe("PUT /v2/products/:link_id/variant_categories/:id", () => {
  const update = (params: Record<string, unknown>) =>
    run("PUT", "/v2/products/:link_id/variant_categories/:id", params, { variantCategory: category });

  it("renames the category to the cast of a JSON false title", async () => {
    const rendered = await update({ title: false });
    expect(mocks.tx.variantCategory.update).toHaveBeenCalledWith({ where: { id: 9n }, data: { title: "0" } });
    expect(JSON.parse(String(rendered.body)).variant_category.title).toBe("0");
  });
});

describe("version writes", () => {
  const variantsPath = "/v2/products/:link_id/variant_categories/:variant_category_id/variants";
  const destroy = (variant: { deleted_at: Date | null }) => run("DELETE", `${variantsPath}/:id`, {}, { variant });
  const create = (params: Record<string, unknown>) => run("POST", variantsPath, params, { variantCategory: category });

  beforeEach(() => {
    variants.assertPlainVariantProduct.mockReset().mockResolvedValue(undefined);
    variants.Variants.save.mockReset();
    variants.Variants.withLock.mockReset();
    variants.buildVariant.mockClear();
  });

  it("answers a delete of a version that is already deleted with success and no write", async () => {
    mocks.db.$transaction.mockClear();
    const rendered = await destroy({ deleted_at: new Date() });

    expect(rendered.status).toBe(200);
    expect(JSON.parse(String(rendered.body))).toMatchObject({ success: true });
    expect(variants.Variants.withLock).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("hands a version of a product the model refuses back to Rails before building anything", async () => {
    variants.assertPlainVariantProduct.mockRejectedValueOnce(new Error("a version of a tiered membership"));

    await expect(create({ name: "Gold" })).rejects.toThrow("a version of a tiered membership");
    expect(variants.buildVariant).not.toHaveBeenCalled();
    expect(variants.Variants.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a fractional price",
      { name: "Large", price_difference_cents: 1.5 },
      "a version amount that is not text or a whole number",
    ],
    [
      "a price outside the column",
      { name: "Large", price_difference_cents: "3000000000" },
      "a version amount outside the column's range",
    ],
    [
      "a limit that is a list",
      { name: "Large", max_purchase_count: [1] },
      "a version amount that is not text or a whole number",
    ],
    [
      "a name that is a number",
      { name: 5 },
      "a version name or description that is not text, or too long for its column",
    ],
    [
      "a description over 255 characters",
      { name: "Large", description: "x".repeat(256) },
      "a version name or description that is not text, or too long for its column",
    ],
  ])("hands %s back to Rails before the save", async (_name, params, reason) => {
    await expect(create(params)).rejects.toThrow(reason);
    expect(variants.Variants.save).not.toHaveBeenCalled();
  });

  it.each(["PATCH", "PUT"])("hands a %s update with rich content back to Rails", async (method) => {
    await expect(
      run(method, `${variantsPath}/:id`, { rich_content: "[]" }, { variant: { deleted_at: null } }),
    ).rejects.toThrow("the rich content of a version");
    expect(variants.assertPlainVariantProduct).not.toHaveBeenCalled();
  });
});
