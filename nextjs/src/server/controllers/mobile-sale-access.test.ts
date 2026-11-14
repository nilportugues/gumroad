import { beforeEach, describe, expect, it, vi } from "vitest";

import { PurchaseFlags } from "../search/flags.ts";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, accessRecord, setLibraryFlag } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  accessRecord: vi.fn(),
  setLibraryFlag: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
  castRow: (_: string, row: unknown) => row,
}));
vi.mock("../models/purchase-access-record.ts", () => ({ accessRecord }));
vi.mock("../models/purchase-library-writes.ts", () => ({
  loadLibraryPurchase: (row: unknown, timezone: string) => ({ row, timezone }),
  setLibraryFlag,
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./mobile-sale-access.ts");

const find = (pattern: string) => actions.find((registered) => registered.pattern === pattern)!;
const revoke = find("/mobile/sales/:id/revoke_access");
const undo = find("/mobile/sales/:id/undo_revoke_access");

const owner = { id: 7n, timezone: "Pacific Time (US & Canada)" };
const auth = { owner } as unknown as MobileAuth;
const input = (id: unknown) => ({ params: { id } }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;
const status = (result: unknown) => (result as { status: number }).status;
const sale = { id: 5n, seller_id: 7n };
const record = (overrides: Record<string, unknown> = {}) => ({
  accessRevoked: false,
  refunded: false,
  hasSubscription: false,
  linkIsPhysical: () => false,
  ...overrides,
});

beforeEach(() => {
  selectRows.mockReset();
  accessRecord.mockReset();
  setLibraryFlag.mockReset();
});

describe("PUT /mobile/sales/:id/revoke_access", () => {
  it("registers behind the mobile_api scope", () => {
    expect(revoke.method).toBe("PUT");
    expect(revoke.scopes).toEqual(["mobile_api"]);
  });

  it("answers 404 for an id that does not decrypt, without reading the database", async () => {
    const result = await revoke.run(input("not-an-id"), auth);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await revoke.run(input("5"), auth);
    expect(status(result)).toBe(404);
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("sets is_access_revoked in the seller's time zone and answers success", async () => {
    selectRows.mockResolvedValueOnce([sale]);
    accessRecord.mockResolvedValue(record());
    const result = await revoke.run(input("5"), auth);
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: true });
    expect(setLibraryFlag).toHaveBeenCalledWith({ row: sale, timezone: owner.timezone }, "is_access_revoked", true);
  });

  it.each([
    ["already revoked", { accessRevoked: true }],
    ["refunded", { refunded: true }],
    ["physical", { linkIsPhysical: () => true }],
    ["a subscription", { hasSubscription: true }],
  ])("answers 401 Not authorized for a sale that is %s", async (_, overrides) => {
    selectRows.mockResolvedValueOnce([sale]);
    accessRecord.mockResolvedValue(record(overrides));
    const result = await revoke.run(input("5"), auth);
    expect(status(result)).toBe(401);
    expect(body(result)).toEqual({ success: false, message: "Not authorized" });
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });
});

describe("PUT /mobile/sales/:id/undo_revoke_access", () => {
  it("clears is_access_revoked on a revoked sale", async () => {
    selectRows.mockResolvedValueOnce([{ ...sale, flags: PurchaseFlags.set(0n, "is_access_revoked", true) }]);
    accessRecord.mockResolvedValue(record({ accessRevoked: true }));
    const result = await undo.run(input("5"), auth);
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: true });
    expect(setLibraryFlag).toHaveBeenCalledWith(expect.anything(), "is_access_revoked", false);
  });

  it("answers 401 Not authorized for a sale whose access is not revoked", async () => {
    selectRows.mockResolvedValueOnce([sale]);
    accessRecord.mockResolvedValue(record());
    const result = await undo.run(input("5"), auth);
    expect(status(result)).toBe(401);
    expect(body(result)).toEqual({ success: false, message: "Not authorized" });
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await undo.run(input("5"), auth);
    expect(status(result)).toBe(404);
  });
});
