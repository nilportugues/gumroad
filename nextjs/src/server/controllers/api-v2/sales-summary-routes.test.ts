import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17s-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, registeredApiV2Routes } from "./base.ts";

const mocks = vi.hoisted(() => ({
  salesSummary: vi.fn((_owner: unknown, args: unknown) => Promise.resolve({ args })),
  selectRows: vi.fn(() => Promise.resolve([] as Record<string, unknown>[])),
  accessRecord: vi.fn(() =>
    Promise.resolve({ accessRevoked: false, refunded: false, hasSubscription: false, linkIsPhysical: () => false }),
  ),
  setLibraryFlag: vi.fn(() => Promise.resolve()),
}));
vi.mock("./sales-summary.ts", async (original) => ({
  ...(await original<object>()),
  salesSummary: mocks.salesSummary,
}));
vi.mock("../../models/sql.ts", async (original) => ({ ...(await original<object>()), selectRows: mocks.selectRows }));
vi.mock("../../models/purchase-access-record.ts", () => ({ accessRecord: mocks.accessRecord }));
vi.mock("../../models/purchase-library-writes.ts", () => ({
  loadLibraryPurchase: (row: unknown) => row,
  setLibraryFlag: mocks.setLibraryFlag,
}));
vi.mock("../../models/purchase-json.ts", () => ({
  followingEmails: vi.fn(),
  purchasesAsJsonV2: (rows: { id: bigint }[]) => Promise.resolve(rows.map((row) => ({ id: Number(row.id) }))),
}));

await import("./sales.ts");

const owner = { id: 7n, email: "seller@example.com", timezone: "UTC" };
const route = (method: string, pattern: string) =>
  registeredApiV2Routes().find((r) => r.method === method && r.pattern === pattern)!;
const call = (method: string, pattern: string, input: Partial<ApiV2Input>) =>
  route(method, pattern).run({ owner, params: {}, routeParams: {}, ...input } as unknown as ApiV2Input);
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  mocks.salesSummary.mockClear();
  mocks.selectRows.mockReset().mockResolvedValue([]);
  mocks.setLibraryFlag.mockClear();
});

describe("GET /v2/sales/summary", () => {
  const summary = (params: Record<string, unknown>) => call("GET", "/v2/sales/summary", { params });

  it("reads a range ending on a given day as the 30 days up to it", async () => {
    await summary({ to: "2026-03-31" });

    expect(mocks.salesSummary).toHaveBeenCalledWith(owner, { from: "2026-03-02", to: "2026-03-31", groupBy: null });
  });

  it("answers 400 for a group_by that is not one of the groups", async () => {
    const result = await summary({ group_by: "year" });

    expect(result).toMatchObject({ status: 400 });
    expect(body(result).error).toBe("Invalid group_by. Valid values are: product, day, week, month, hour.");
  });

  it.each([["from"], ["to"]])("answers 400 naming the %s field when it is not a date", async (field) => {
    const result = await summary({ [field]: "2026-02-30" });

    expect(result).toMatchObject({ status: 400 });
    expect(String(body(result).error)).toContain(`field '${field}'`);
  });

  it("answers 400 when from is after to", async () => {
    expect(body(await summary({ from: "2026-02-02", to: "2026-02-01" })).error).toBe(
      "'from' must be on or before 'to'.",
    );
  });

  it("answers 400 for an hourly range past a week", async () => {
    const result = await summary({ from: "2026-02-01", to: "2026-02-09", group_by: "hour" });

    expect(body(result).error).toBe("Date range cannot exceed 7 days when grouping by hour.");
    expect(mocks.salesSummary).not.toHaveBeenCalled();
  });

  it("hands a parameter that is not text to Rails", async () => {
    await expect(summary({ from: ["2026-02-01"] })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("routes that move money or send mail", () => {
  const routes = [
    ["PUT", "/v2/sales/:id/refund"],
    ["PUT", "/v2/sales/:id/mark_as_shipped"],
  ] as const;

  it.each(routes)("answers that the sale was not found on %s %s", async (method, pattern) => {
    const result = await call(method, pattern, { routeParams: { id: encrypt(5) } });

    expect(body(result)).toEqual({ success: false, message: "The sale was not found." });
  });

  it.each(routes)("hands %s %s of a sale to Rails", async (method, pattern) => {
    mocks.selectRows.mockResolvedValue([{ id: 5n }]);

    await expect(call(method, pattern, { routeParams: { id: encrypt(5) } })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("PUT /v2/sales/:id/revoke_access and undo_revoke_access", () => {
  const revoke = () => call("PUT", "/v2/sales/:id/revoke_access", { routeParams: { id: encrypt(5) } });
  const undo = () => call("PUT", "/v2/sales/:id/undo_revoke_access", { routeParams: { id: encrypt(5) } });

  it("requires the edit_sales scope itself", () => {
    expect(route("PUT", "/v2/sales/:id/revoke_access").requireScope).toEqual(["edit_sales"]);
    expect(route("PUT", "/v2/sales/:id/undo_revoke_access").requireScope).toEqual(["edit_sales"]);
  });

  it("revokes access and answers with the sale", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 5n }]);

    expect(body(await revoke())).toEqual({ success: true, sale: { id: 5 } });
    expect(mocks.setLibraryFlag).toHaveBeenCalledWith({ id: 5n }, "is_access_revoked", true);
  });

  it("refuses to revoke access that is already revoked and writes nothing", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 5n }]);
    mocks.accessRecord.mockResolvedValueOnce({
      accessRevoked: true,
      refunded: false,
      hasSubscription: false,
      linkIsPhysical: () => false,
    });

    expect(body(await revoke())).toEqual({ success: false, message: "Access cannot be revoked for this sale." });
    expect(mocks.setLibraryFlag).not.toHaveBeenCalled();
  });

  it("refuses to undo a revocation that is not in place", async () => {
    mocks.selectRows.mockResolvedValue([{ id: 5n }]);

    expect(body(await undo())).toEqual({ success: false, message: "Access is not revoked for this sale." });
    expect(mocks.setLibraryFlag).not.toHaveBeenCalled();
  });

  it("answers that the sale was not found", async () => {
    expect(body(await revoke())).toEqual({ success: false, message: "The sale was not found." });
  });
});
