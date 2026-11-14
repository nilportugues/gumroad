import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../application-controller.ts";

const mocks = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "url-redirect-files-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";
  return {
    db: {
      baseVariantsPurchase: { findMany: vi.fn() },
      baseVariant: { findMany: vi.fn() },
      variantCategory: { findUnique: vi.fn(), count: vi.fn() },
      baseVariantsProductFile: { findMany: vi.fn() },
      richContent: { count: vi.fn() },
      productFile: { findMany: vi.fn() },
    },
  };
});

vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));

const { aliveProductFiles, contentProvider } = await import("./files.ts");

const SHARED_PAGES = 1n << 24n;
const variant = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  type: "Variant",
  deleted_at: null,
  variant_category_id: 4,
  ...overrides,
});
const loaded = (product: Record<string, unknown> = {}, purchase: unknown = { id: 5n }) =>
  ({
    redirect: { preorder_id: null },
    purchase,
    product: { id: 3n, user_id: 2n, flags: 0n, ...product },
  }) as never;
const file = (id: bigint, position: number) => ({ id, position, url: null, flags: 0n, filetype: "pdf" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.baseVariantsPurchase.findMany.mockResolvedValue([{ base_variant_id: 7 }]);
  mocks.db.baseVariant.findMany.mockResolvedValue([variant()]);
  mocks.db.variantCategory.findUnique.mockResolvedValue({ id: 4, link_id: 3 });
  mocks.db.variantCategory.count.mockResolvedValue(1);
  mocks.db.richContent.count.mockResolvedValue(0);
  mocks.db.baseVariantsProductFile.findMany.mockResolvedValue([]);
  mocks.db.productFile.findMany.mockResolvedValue([]);
});

describe("contentProvider", () => {
  it("is the product for a redirect without a purchase and for a purchase without a version", async () => {
    await expect(contentProvider(loaded({}, null))).resolves.toEqual({ kind: "product" });
    mocks.db.baseVariantsPurchase.findMany.mockResolvedValue([]);
    await expect(contentProvider(loaded())).resolves.toEqual({ kind: "product" });
  });

  it("is the one alive version the purchase bought", async () => {
    await expect(contentProvider(loaded())).resolves.toEqual({ kind: "variant", variant: variant() });
  });

  it.each([
    ["a SKU", () => mocks.db.baseVariant.findMany.mockResolvedValue([variant({ type: "Sku" })])],
    [
      "a version next to a SKU",
      () => {
        mocks.db.baseVariantsPurchase.findMany.mockResolvedValue([{ base_variant_id: 7 }, { base_variant_id: 8 }]);
        mocks.db.baseVariant.findMany.mockResolvedValue([variant(), variant({ id: 8, type: "Sku" })]);
      },
    ],
    [
      "several versions",
      () => {
        mocks.db.baseVariantsPurchase.findMany.mockResolvedValue([{ base_variant_id: 7 }, { base_variant_id: 8 }]);
        mocks.db.baseVariant.findMany.mockResolvedValue([variant(), variant({ id: 8 })]);
      },
    ],
    ["a link to a version that is gone", () => mocks.db.baseVariant.findMany.mockResolvedValue([])],
    ["a deleted version", () => mocks.db.baseVariant.findMany.mockResolvedValue([variant({ deleted_at: new Date() })])],
    [
      "a version of another product",
      () => mocks.db.variantCategory.findUnique.mockResolvedValue({ id: 4, link_id: 99 }),
    ],
    ["a version without a category", () => mocks.db.variantCategory.findUnique.mockResolvedValue(null)],
  ])("hands back %s", async (_, arrange) => {
    arrange();
    await expect(contentProvider(loaded())).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back versions that share one set of pages, whose provider is the product", async () => {
    await expect(contentProvider(loaded({ flags: SHARED_PAGES }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("aliveProductFiles for a purchased version", () => {
  it("lists only the files joined to the version, alive, in position order", async () => {
    mocks.db.baseVariantsProductFile.findMany.mockResolvedValue([{ product_file_id: 20 }, { product_file_id: 21 }]);
    mocks.db.productFile.findMany.mockResolvedValue([file(21n, 1), file(20n, 2)]);

    const files = await aliveProductFiles(loaded(), [], { versions: true });

    expect(files.map(({ file: row }) => row.id)).toEqual([21n, 20n]);
    expect(mocks.db.baseVariantsProductFile.findMany).toHaveBeenCalledWith({ where: { base_variant_id: 7 } });
    expect(mocks.db.productFile.findMany).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [20n, 21n] } }, { deleted_at: null }] },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
  });

  it("lists the embedded files of the version in the order its pages embed them", async () => {
    mocks.db.baseVariantsProductFile.findMany.mockResolvedValue([{ product_file_id: 20 }, { product_file_id: 21 }]);
    mocks.db.productFile.findMany.mockResolvedValue([file(20n, 1), file(21n, 2)]);

    const files = await aliveProductFiles(loaded(), [21n, 20n], { versions: true });

    expect(files.map(({ file: row }) => row.id)).toEqual([21n, 20n]);
    expect(mocks.db.productFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: { in: [20n, 21n] } }, { deleted_at: null }, { id: { in: [21n, 20n] } }] },
      }),
    );
  });

  it("hands back outside the download page, which is the only place the rule is proved", async () => {
    await expect(aliveProductFiles(loaded())).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.db.productFile.findMany).not.toHaveBeenCalled();
  });

  it("hands back a version with rich content when the caller read none of it", async () => {
    mocks.db.richContent.count.mockResolvedValue(1);

    await expect(aliveProductFiles(loaded(), undefined, { versions: true })).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.db.richContent.count).toHaveBeenCalledWith({
      where: { entity_type: "BaseVariant", entity_id: 7n, deleted_at: null },
    });
  });
});

describe("aliveProductFiles for a product with versions", () => {
  it("hands back a purchase that bought none of them", async () => {
    mocks.db.baseVariantsPurchase.findMany.mockResolvedValue([]);

    await expect(aliveProductFiles(loaded(), [], { versions: true })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
