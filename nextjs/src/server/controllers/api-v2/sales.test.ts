import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, registeredApiV2Routes } from "./base.ts";

const { queueSalesExport, salesExportQuery } = vi.hoisted(() => ({
  queueSalesExport: vi.fn(() => Promise.resolve(5n)),
  salesExportQuery: vi.fn((_sellerId: unknown, filters: unknown) => ({ filters })),
}));
vi.mock("../../exports/sales-export.ts", () => ({ queueSalesExport, salesExportQuery }));

await import("./sales.ts");

const route = registeredApiV2Routes().find(
  (route) => route.method === "POST" && route.pattern === "/v2/sales/exports",
)!;
const call = (params: Record<string, unknown>) =>
  route.run({ owner: { id: 7n, email: "seller@example.com" }, params } as unknown as ApiV2Input);

describe("POST /v2/sales/exports", () => {
  beforeEach(() => {
    queueSalesExport.mockClear();
    salesExportQuery.mockClear();
  });

  it("queues the export for the dates and answers with the owner's email", async () => {
    const result = await call({ from: "2026-1-5", to: "2026-02-03 10:30:00" });

    expect(salesExportQuery).toHaveBeenCalledWith(7n, { startDate: "2026-01-05", endDate: "2026-02-03" });
    expect(queueSalesExport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      success: true,
      status: "queued",
      recipient_email: "seller@example.com",
    });
  });

  it("answers 400 naming the first wrong date and queues nothing", async () => {
    const result = await call({ from: "394293", to: "invalid-date" });

    expect(result).toMatchObject({ status: 400 });
    expect((JSON.parse((result as { body: string }).body) as { error: string }).error).toContain("field 'from'");
    expect(queueSalesExport).not.toHaveBeenCalled();
  });

  it.each([["2026-01-05abc"], ["2026-01-05 25:00:00"], [20260105], [["2026-01-05"]]])(
    "hands the date %j to Rails",
    async (from) => {
      await expect(call({ from })).rejects.toBeInstanceOf(HandBackToRails);
      expect(queueSalesExport).not.toHaveBeenCalled();
    },
  );

  it("hands a product_id that is not text to Rails", async () => {
    await expect(call({ product_id: ["x"] })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
