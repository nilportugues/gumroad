import type { Link, User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    refundPolicy: { findFirst: vi.fn() },
    assetPreview: { count: vi.fn() },
    productFile: { count: vi.fn() },
    preorderLink: { count: vi.fn() },
  },
  flags: {
    is_tiered_membership: 1n << 18n,
    is_bundle: 1n << 25n,
    product_refund_policy_enabled: 1n,
    purchasing_power_parity_disabled: 1n << 26n,
  } as Record<string, bigint>,
}));
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("../../models/link.ts", () => ({
  Links: {},
  defaultPriceCents: vi.fn(),
  LinkFlags: { isSet: (flags: bigint, name: string) => (flags & (mocks.flags[name] ?? 0n)) !== 0n },
}));
vi.mock("../../models/user.ts", () => ({
  UserFlags: {
    isSet: (flags: bigint, name: string) => name === "purchasing_power_parity_enabled" && (flags & 4n) !== 0n,
  },
}));
vi.mock("../../presenters/product-reads.ts", () => ({}));
vi.mock("../../presenters/product.ts", () => ({}));
vi.mock("../../page-props/seller-products/listing.ts", () => ({}));
vi.mock("./product-resources.ts", () => ({}));

const { assertProductJsonSupported } = await import("./product-json.ts");
const { HandBackToRails } = await import("../application-controller.ts");

const owner = { id: 1n, flags: 0n } as unknown as User;
const product = (overrides: Partial<Link> = {}) =>
  ({ id: 5n, taxonomy_id: null, flags: 0n, ...overrides }) as unknown as Link;
const check = (links: Link[], overrides: { owner?: User; scopes?: string[] } = {}) =>
  assertProductJsonSupported(links, {
    owner: overrides.owner ?? owner,
    scopes: overrides.scopes ?? ["edit_products"],
    slim: false,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.refundPolicy.findFirst.mockResolvedValue(null);
  mocks.db.assetPreview.count.mockResolvedValue(0);
  mocks.db.productFile.count.mockResolvedValue(0);
  mocks.db.preorderLink.count.mockResolvedValue(0);
});

describe("products the v2 API serializer hands back to Rails", () => {
  it("accepts a plain product", async () => {
    await expect(check([product()])).resolves.toBeUndefined();
  });

  it.each(["view_sales", "account"])(
    "hands back a token with the %s scope, whose counts come from Elasticsearch",
    async (scope) => {
      await expect(check([product()], { scopes: ["edit_products", scope] })).rejects.toBeInstanceOf(HandBackToRails);
    },
  );

  it("hands back a tiered membership and a bundle", async () => {
    await expect(check([product({ flags: mocks.flags.is_tiered_membership })])).rejects.toBeInstanceOf(HandBackToRails);
    await expect(check([product({ flags: mocks.flags.is_bundle })])).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a product-level refund policy only when it exists", async () => {
    await expect(check([product({ flags: 1n })])).resolves.toBeUndefined();

    mocks.db.refundPolicy.findFirst.mockResolvedValue({ id: 1n });
    await expect(check([product({ flags: 1n })])).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back purchasing power parity unless the product opts out of it", async () => {
    const ppp = { ...owner, flags: 4n } as User;

    await expect(check([product()], { owner: ppp })).rejects.toBeInstanceOf(HandBackToRails);
    await expect(
      check([product({ flags: mocks.flags.purchasing_power_parity_disabled })], { owner: ppp }),
    ).resolves.toBeUndefined();
  });

  it.each(["assetPreview", "productFile", "preorderLink"] as const)(
    "hands back a product with a row in %s",
    async (model) => {
      mocks.db[model].count.mockResolvedValue(1);

      await expect(check([product()])).rejects.toBeInstanceOf(HandBackToRails);
    },
  );
});
