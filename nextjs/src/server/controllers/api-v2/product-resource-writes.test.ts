import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => {
  const tx = { variantCategory: { create: vi.fn(), update: vi.fn() }, link: { update: vi.fn() } };
  return { tx, db: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) } };
});
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("../../models/link.ts", () => ({ invalidateProductCache: vi.fn() }));

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
  route(method, pattern).run({ params, state: { product, ...state } } as never);
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
