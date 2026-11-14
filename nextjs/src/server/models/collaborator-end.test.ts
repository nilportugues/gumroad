import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn(), valid: vi.fn(), assign: vi.fn() }));

vi.mock("./sql.ts", () => ({
  selectRows: mocks.selectRows,
  column: () => "",
  table: () => "",
  castRow: (_model: string, row: unknown) => row,
}));
vi.mock("../mail/active-job.ts", () => ({ deliverLater: vi.fn() }));
vi.mock("../mail/delivery.ts", () => ({ mailRoute: () => "ruby" }));
vi.mock("./concerns/job-runtime.ts", () => ({ currentJobsRuntime: () => ({}) }));
vi.mock("./link.ts", () => ({
  Links: { load: (row: object) => ({ ...row, assign: mocks.assign }), valid: mocks.valid },
  LinkFlags: { set: (flags: bigint) => flags & ~(1n << 27n) },
}));

const { endBlocker } = await import("./collaborator-end.ts");

// Deliberately partial: endBlocker reads only these columns.
const row = { id: 5, seller_id: 3, affiliate_user_id: 9, affiliate_basis_points: 3000, flags: 0 } as Parameters<
  typeof endBlocker
>[0];
const product = { id: 11n, flags: 1n << 27n };

// endBlocker reads the two accounts, then the products.
const reads = (users: object[] = [{ id: 3 }, { id: 9 }], products: object[] = [product]) =>
  mocks.selectRows.mockResolvedValueOnce(users).mockResolvedValueOnce(products);

beforeEach(() => {
  mocks.selectRows.mockReset();
  mocks.valid.mockReset().mockResolvedValue(true);
  mocks.assign.mockReset();
});

describe("endBlocker", () => {
  it("accepts a collaboration whose rows validate", async () => {
    reads();
    expect(await endBlocker(row)).toBeNull();
    expect(mocks.assign).toHaveBeenCalledWith({ flags: 0n });
  });

  it.each([
    ["no seller", { seller_id: null }, /seller or an account/u],
    ["no account", { affiliate_user_id: null }, /seller or an account/u],
    ["a commission below the range", { affiliate_basis_points: 99 }, /outside the allowed range/u],
    ["a commission above the range", { affiliate_basis_points: 5001 }, /outside the allowed range/u],
    ["no commission for all products", { affiliate_basis_points: null, flags: 1 }, /without a commission/u],
  ])("refuses %s before reading anything else", async (_name, change, reason) => {
    expect(await endBlocker({ ...row, ...change } as never)).toMatch(reason);
    expect(mocks.selectRows).not.toHaveBeenCalled();
  });

  it("accepts a missing commission when the collaboration is per product", async () => {
    reads();
    expect(await endBlocker({ ...row, affiliate_basis_points: null })).toBeNull();
  });

  it("refuses a collaboration whose seller or account is gone", async () => {
    reads([{ id: 3 }]);
    expect(await endBlocker(row)).toMatch(/missing/u);
  });

  it("refuses a product that would fail its own save", async () => {
    reads();
    mocks.valid.mockResolvedValue(false);
    expect(await endBlocker(row)).toMatch(/own validation/u);
  });

  it("refuses a product whose save Node has not ported, before anything is written", async () => {
    reads();
    mocks.valid.mockRejectedValue(new Error("not ported"));
    await expect(endBlocker(row)).rejects.toThrow("not ported");
  });
});
