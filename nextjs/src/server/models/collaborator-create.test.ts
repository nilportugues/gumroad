import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn(), valid: vi.fn(), brazilian: vi.fn() }));

vi.mock("./sql.ts", () => ({
  selectRows: mocks.selectRows,
  column: () => "",
  table: () => "",
  castRow: (_model: string, row: unknown) => row,
}));
vi.mock("./link.ts", () => ({
  Links: {
    load: (row: object) => ({ ...row, get: () => 0n, assign: vi.fn() }),
    valid: mocks.valid,
  },
  LinkFlags: { set: (flags: bigint) => flags | (1n << 27n) },
}));
vi.mock("./collaborator-end.ts", () => ({
  Collaborators: {},
  CollaboratorInvitations: {},
  COLLABORATOR: "Collaborator",
}));
vi.mock("../page-props/dashboard/payout-info.ts", () => ({ hasBrazilianStripeConnectAccount: mocks.brazilian }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "missing" ? null : Number(id)) }));

const { resolveCreation } = await import("./collaborator-create.ts");

const SELLER = 3n;
const user = { id: 9, flags: 0n, deleted_at: null };
const requested = {
  email: "ada@example.com",
  applyToAllProducts: true,
  dontShow: false,
  percent: 30,
  products: [{ externalId: "11", percent: null, dontShow: false }],
};

// resolveCreation reads, in order: the accounts with the email, an existing collaboration, the invited seller's own collaboration
// with the inviter, one row per product, and (creationBlocker) the products, the assignments, then the self-service rows.
const reads = (
  rows: {
    users?: object[];
    existing?: object[];
    accepted?: object[];
    product?: object[];
    links?: object[];
    assigned?: object[];
    selfService?: object[];
  } = {},
) =>
  mocks.selectRows
    .mockResolvedValueOnce(rows.users ?? [user])
    .mockResolvedValueOnce(rows.existing ?? [])
    .mockResolvedValueOnce(rows.accepted ?? [])
    .mockResolvedValueOnce(rows.product ?? [{ id: 11 }])
    .mockResolvedValueOnce(rows.links ?? [{ id: 11, flags: 0n, deleted_at: null }])
    .mockResolvedValueOnce(rows.assigned ?? [])
    .mockResolvedValueOnce(rows.selfService ?? []);

beforeEach(() => {
  mocks.selectRows.mockReset();
  mocks.valid.mockReset().mockResolvedValue(true);
  mocks.brazilian.mockReset().mockResolvedValue(false);
});

describe("resolveCreation", () => {
  it("invites a collaborator who has not accepted the inviter, with the commission in basis points", async () => {
    reads();
    expect(await resolveCreation(SELLER, requested)).toEqual({
      sellerId: 3,
      affiliateUserId: 9,
      invited: true,
      basisPoints: 3000,
      applyToAllProducts: true,
      dontShow: false,
      products: [{ linkId: 11, basisPoints: 3000, dontShow: false }],
    });
  });

  it("skips the invitation when the invited seller already accepted the inviter", async () => {
    reads({ accepted: [{ id: 1 }] });
    expect(await resolveCreation(SELLER, requested)).toMatchObject({ invited: false });
  });

  it("takes each product's own commission and credit setting when the collaboration is per product", async () => {
    reads();
    const result = await resolveCreation(SELLER, {
      ...requested,
      applyToAllProducts: false,
      percent: 10,
      products: [{ externalId: "11", percent: 25, dontShow: true }],
    });
    expect(result).toMatchObject({ basisPoints: 1000, products: [{ linkId: 11, basisPoints: 2500, dontShow: true }] });
  });

  it.each([
    ["an email without an account", { users: [] }, "The email address isn't associated with a Gumroad account."],
    ["an existing collaboration", { existing: [{ id: 1 }] }, "The user is already a collaborator"],
    ["a product the seller does not have", { product: [] }, "Product not found"],
    [
      "an invited seller who reviews requests",
      { users: [{ ...user, flags: 1n << 39n }] },
      "You cannot add this user as a collaborator",
    ],
  ])("answers %s with the service's message", async (_name, rows, message) => {
    reads(rows);
    expect(await resolveCreation(SELLER, requested)).toEqual({ message });
  });

  it.each([[null], [[]]])("answers a missing product list (%j) before looking at any product", async (products) => {
    mocks.selectRows.mockResolvedValueOnce([user]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await resolveCreation(SELLER, { ...requested, products })).toEqual({
      message: "At least one product must be selected",
    });
  });

  it("answers a blank email without a lookup", async () => {
    expect(await resolveCreation(SELLER, { ...requested, email: " " })).toEqual({
      message: "The email address isn't associated with a Gumroad account.",
    });
    expect(mocks.selectRows).not.toHaveBeenCalled();
  });

  it("answers an id that does not decrypt as a missing product", async () => {
    mocks.selectRows.mockResolvedValueOnce([user]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(
      await resolveCreation(SELLER, {
        ...requested,
        products: [{ externalId: "missing", percent: null, dontShow: false }],
      }),
    ).toEqual({ message: "Product not found" });
  });

  it.each([
    ["several accounts with the email", { users: [user, { ...user, id: 10 }] }, /several accounts/u],
    ["a deleted product", { links: [{ id: 11, flags: 0n, deleted_at: new Date() }] }, /deleted/u],
    ["a product with a collaborator or an affiliate", { assigned: [{ id: 1 }] }, /already has/u],
    ["a product with a self-service affiliate", { selfService: [{ id: 1 }] }, /self-service/u],
  ])("hands back %s", async (_name, rows, reason) => {
    reads(rows);
    expect(await resolveCreation(SELLER, requested)).toEqual({ blocked: expect.stringMatching(reason) });
  });

  it.each([
    ["a commission below the range", { percent: 0 }, /outside the allowed range/u],
    ["no commission for all products", { percent: null }, /without a commission/u],
  ])("hands back %s", async (_name, change, reason) => {
    reads();
    expect(await resolveCreation(SELLER, { ...requested, ...change })).toEqual({
      blocked: expect.stringMatching(reason),
    });
  });

  it("refuses a commission above the range with the errors of the collaborator and its one product", async () => {
    reads();
    expect(await resolveCreation(SELLER, { ...requested, percent: 51 })).toEqual({
      message: "Product affiliates affiliate basis points must be less than or equal to 5000",
      errors: {
        "collaborator.product_affiliates.affiliate_basis_points": "must be less than or equal to 5000",
        "collaborator.affiliate_basis_points": "must be less than or equal to 5000",
        "collaborator.base": "Product affiliates affiliate basis points must be less than or equal to 5000",
      },
    });
  });

  it("hands back a commission above the range for several products", async () => {
    mocks.selectRows
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 11 }])
      .mockResolvedValueOnce([{ id: 12 }]);
    const products = [requested.products[0]!, { ...requested.products[0]!, externalId: "12" }];
    expect(await resolveCreation(SELLER, { ...requested, percent: 51, products })).toEqual({
      blocked: expect.stringMatching(/outside the allowed range/u),
    });
  });

  it("hands back a product commission outside the range when the collaboration is per product", async () => {
    reads();
    const result = await resolveCreation(SELLER, {
      ...requested,
      applyToAllProducts: false,
      products: [{ externalId: "11", percent: null, dontShow: false }],
    });
    expect(result).toEqual({ blocked: expect.stringMatching(/product commission/u) });
  });

  it("hands back the same product twice", async () => {
    mocks.selectRows
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 11 }])
      .mockResolvedValueOnce([{ id: 11 }]);
    const twice = { ...requested.products[0]! };
    expect(await resolveCreation(SELLER, { ...requested, products: [twice, twice] })).toEqual({
      blocked: expect.stringMatching(/twice/u),
    });
  });

  it("hands back a Brazilian Stripe account on either side, and a collaboration with oneself", async () => {
    reads();
    mocks.brazilian.mockResolvedValueOnce(true);
    expect(await resolveCreation(SELLER, requested)).toEqual({
      blocked: expect.stringMatching(/seller with a Brazilian/u),
    });
    reads();
    mocks.brazilian.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await resolveCreation(SELLER, requested)).toEqual({
      blocked: expect.stringMatching(/collaborator with a Brazilian/u),
    });
    mocks.selectRows.mockReset().mockResolvedValueOnce([{ ...user, id: 3 }]);
    expect(await resolveCreation(SELLER, requested)).toEqual({ blocked: expect.stringMatching(/oneself/u) });
  });

  it("hands back a product that would fail its own save once marked as a collab", async () => {
    reads();
    mocks.valid.mockResolvedValue(false);
    expect(await resolveCreation(SELLER, requested)).toEqual({ blocked: expect.stringMatching(/own validation/u) });
  });
});
