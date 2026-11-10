import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinkFlags } from "../models/link.ts";
import { PurchaseFlags } from "../search/flags.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, setLibraryFlag, loadSellerContext } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  setLibraryFlag: vi.fn(),
  loadSellerContext: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({ registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered) }));
vi.mock("../models/sql.ts", async (original) => ({ ...(await original<typeof import("../models/sql.ts")>()), selectRows, castRow: (_: string, row: unknown) => row }));
vi.mock("../models/purchase-library-writes.ts", () => ({ loadLibraryPurchase: (row: unknown, timezone: string) => ({ row, timezone }), setLibraryFlag }));
vi.mock("../policies/seller-context.ts", async (original) => ({ ...(await original<typeof import("../policies/seller-context.ts")>()), loadSellerContext }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null) }));

await import("./purchase-access-writes.ts");

const find = (pattern: string) => specs.find((spec) => spec.method === "PUT" && spec.pattern === pattern)!;
const revoke = find("/purchases/:id/revoke_access");
const undo = find("/purchases/:id/undo_revoke_access");

const seller = { id: 7n, timezone: "Pacific Time (US & Canada)" };
const REVOKED = PurchaseFlags.set(0n, "is_access_revoked", true);
const PHYSICAL = LinkFlags.set(0n, "is_physical", true);
const purchaseRow = (overrides: Record<string, unknown> = {}) => ({ id: 5n, seller_id: 7n, link_id: 9n, subscription_id: null, stripe_refunded: false, flags: 0n, ...overrides });
const input = (id = "5", signedIn = true): MutationInput =>
  ({ routeParams: { id }, context: { currentSeller: signedIn ? seller : null, loggedInUser: signedIn ? seller : null, impersonatedUser: null } }) as unknown as MutationInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;

// selectRows runs for the purchase, then its link, then (only for a subscription purchase) the subscription.
function stage(purchase: Record<string, unknown> | undefined, linkFlags: bigint | bigint[] = 0n, subscription?: Record<string, unknown>) {
  selectRows.mockResolvedValueOnce(purchase ? [purchase] : []);
  if (!purchase) return;
  selectRows.mockResolvedValueOnce([{ flags: linkFlags }]);
  if (purchase.subscription_id != null) selectRows.mockResolvedValueOnce(subscription ? [subscription] : []);
}

beforeEach(() => {
  selectRows.mockReset();
  setLibraryFlag.mockReset();
  loadSellerContext.mockReset();
  loadSellerContext.mockResolvedValue({ user: seller, seller, memberships: [] });
});

describe("PUT /purchases/:id/revoke_access", () => {
  it("sets is_access_revoked and answers 204", async () => {
    stage(purchaseRow());
    const result = await revoke.run(input());
    expect(status(result)).toBe(204);
    expect(setLibraryFlag).toHaveBeenCalledWith({ row: purchaseRow(), timezone: seller.timezone }, "is_access_revoked", true);
  });

  it("answers 404 JSON for another seller's purchase and writes nothing", async () => {
    stage(purchaseRow({ seller_id: 8n }));
    const result = await revoke.run(input());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, error: "Not found" });
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("raises a routing error for a purchase that does not exist or an id that does not decrypt", async () => {
    stage(undefined);
    await expect(revoke.run(input())).rejects.toThrow("Not Found");
    await expect(revoke.run(input("not-an-id"))).rejects.toThrow("Not Found");
  });

  it.each([
    ["already revoked", purchaseRow({ flags: REVOKED }), 0n],
    ["refunded", purchaseRow({ stripe_refunded: true }), 0n],
    ["for a physical product", purchaseRow(), PHYSICAL],
  ])("answers 401 when the purchase is %s", async (_name, purchase, linkFlags) => {
    stage(purchase, linkFlags as bigint);
    const result = await revoke.run(input());
    expect(status(result)).toBe(401);
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("answers 401 for a subscription purchase but revokes one whose subscription row is gone", async () => {
    stage(purchaseRow({ subscription_id: 3n }), 0n, { id: 3n });
    expect(status(await revoke.run(input()))).toBe(401);
    stage(purchaseRow({ subscription_id: 3n }), 0n, undefined);
    expect(status(await revoke.run(input()))).toBe(204);
  });

  it("answers 401 for a team member who cannot update customers", async () => {
    loadSellerContext.mockResolvedValue({
      user: { id: 11n },
      seller,
      memberships: [{ user_id: 11n, seller_id: 7n, role: "accountant", deleted_at: null }],
    });
    stage(purchaseRow());
    expect(status(await revoke.run(input()))).toBe(401);
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("hands a signed-out request back to Rails", async () => {
    await expect(revoke.run(input("5", false))).rejects.toThrow(/signed-out/u);
  });
});

describe("PUT /purchases/:id/undo_revoke_access", () => {
  it("clears is_access_revoked and answers 204", async () => {
    stage(purchaseRow({ flags: REVOKED }));
    expect(status(await undo.run(input()))).toBe(204);
    expect(setLibraryFlag).toHaveBeenCalledWith(expect.anything(), "is_access_revoked", false);
  });

  it("answers 401 when access is not revoked", async () => {
    stage(purchaseRow());
    expect(status(await undo.run(input()))).toBe(401);
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("restores a refunded purchase's access, since the policy only asks that it is revoked", async () => {
    stage(purchaseRow({ flags: REVOKED, stripe_refunded: true }));
    expect(status(await undo.run(input()))).toBe(204);
  });
});
