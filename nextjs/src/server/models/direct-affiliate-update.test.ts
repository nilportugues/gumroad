import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn() }));

vi.mock("./sql.ts", () => ({
  selectRows: mocks.selectRows,
  column: () => "",
  table: () => "",
  castRow: (_model: string, row: unknown) => row,
}));
vi.mock("../mail/active-job.ts", () => ({ deliverLater: vi.fn() }));
vi.mock("../mail/delivery.ts", () => ({ mailRoute: () => "ruby" }));

const { updateBlocker } = await import("./direct-affiliate-update.ts");

const requested = { applyToAllProducts: false, enabledProducts: [{ destinationUrl: null }], destinationUrl: null };
const edited = {
  id: 5,
  sellerId: 3,
  affiliateUserId: 9,
  affiliateUserEmail: "ada@example.com",
  basisPoints: 1000,
  productId: 11,
  productBasisPoints: 1000,
};
const affiliate = {
  id: 5,
  type: "DirectAffiliate",
  deleted_at: null,
  affiliate_user_id: 9,
  flags: 2,
  destination_url: null,
};
const assignment = { id: 1, affiliate_id: 5, link_id: 11, destination_url: null, affiliate_basis_points: 500 };

// updateBlocker reads: the affiliate, its assignments, the live affiliations of the account, then (creationBlocker) the product and a
// Brazilian merchant account.
const reads = (
  rows: { affiliate?: object; assignments?: object[]; alive?: object[]; product?: object[]; brazilian?: object[] } = {},
) =>
  mocks.selectRows
    .mockResolvedValueOnce([rows.affiliate ?? affiliate])
    .mockResolvedValueOnce(rows.assignments ?? [assignment])
    .mockResolvedValueOnce(rows.alive ?? [{ id: 5 }])
    .mockResolvedValueOnce(rows.product ?? [{ flags: 0n, deleted_at: null }])
    .mockResolvedValueOnce(rows.brazilian ?? []);

beforeEach(() => mocks.selectRows.mockReset());

describe("updateBlocker", () => {
  it("accepts a fee-only edit of the one live affiliation", async () => {
    reads();
    expect(await updateBlocker(requested, edited)).toBeNull();
  });

  it.each([
    ["a deleted affiliate", { affiliate: { ...affiliate, deleted_at: new Date() } }, /deleted/u],
    ["another account", { affiliate: { ...affiliate, affiliate_user_id: 10 } }, /another account/u],
    ["an affiliate for all products", { affiliate: { ...affiliate, flags: 3 } }, /all products/u],
    [
      "an affiliate with a destination url",
      { affiliate: { ...affiliate, destination_url: "https://example.com" } },
      /destination/u,
    ],
    ["a second product", { assignments: [assignment, { ...assignment, id: 2, link_id: 12 }] }, /products/u],
    ["another product", { assignments: [{ ...assignment, link_id: 12 }] }, /products/u],
    [
      "a product with a destination url",
      { assignments: [{ ...assignment, destination_url: "https://example.com" }] },
      /destination/u,
    ],
    ["two live affiliations of the account", { alive: [{ id: 5 }, { id: 6 }] }, /several/u],
  ])("hands back %s", async (_name, rows, message) => {
    reads(rows);
    expect(await updateBlocker(requested, edited)).toMatch(message);
  });

  it("hands back a missing affiliate", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    expect(await updateBlocker(requested, edited)).toMatch(/no longer exists/u);
  });

  it("refuses a fee above the allowed range with the validation message", async () => {
    reads();
    expect(await updateBlocker(requested, { ...edited, basisPoints: 9000 })).toEqual({
      refusal: "Affiliate commission must be between 1% and 75%.",
    });
  });
});
