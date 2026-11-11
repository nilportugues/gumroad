import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17s-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { HandBackToRails } from "../application-controller.ts";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  selectRows: vi.fn(() => Promise.resolve([] as Record<string, unknown>[])),
}));
vi.mock("../../search/api.ts", () => ({ search: mocks.search }));
vi.mock("../../models/sql.ts", async (original) => ({ ...(await original<object>()), selectRows: mocks.selectRows }));

const { salesSummary } = await import("./sales-summary.ts");

const seller = { id: 7n, timezone: "Pacific Time (US & Canada)" };
const bucket = (key: Record<string, string | number>, gross: number, docs = 1) => ({
  key,
  doc_count: docs,
  gross_cents: { value: gross },
  refunded_cents: { value: 0 },
  refunded_units: { doc_count: 0 },
});
const respond = (buckets: ReturnType<typeof bucket>[]) =>
  mocks.search
    .mockResolvedValueOnce({
      body: {
        hits: { total: { value: 3 } },
        aggregations: { gross_cents: { value: 900.0 }, refunded_cents: { value: 0 }, refunded_units: { doc_count: 0 } },
      },
    })
    .mockResolvedValueOnce({ body: { aggregations: { breakdown: { buckets } } } });

beforeEach(() => {
  mocks.search.mockReset();
  mocks.selectRows.mockReset().mockResolvedValue([]);
});

describe("salesSummary", () => {
  it("merges the two buckets of an hour that daylight saving repeats", async () => {
    // 08:30Z and 09:30Z on 2026-11-01 are both 01:30 in Pacific time
    respond([bucket({ date: Date.UTC(2026, 10, 1, 8, 30) }, 500), bucket({ date: Date.UTC(2026, 10, 1, 9, 30) }, 400)]);

    const result = await salesSummary(seller, { from: "2026-11-01", to: "2026-11-01", groupBy: "hour" });

    expect(result.breakdown).toEqual([
      {
        gross_cents: 900,
        net_cents: 900,
        units: 2,
        refunded_cents: 0,
        refunded_units: 0,
        key: "2026-11-01T01:00",
        label: "2026-11-01T01:00",
      },
    ]);
  });

  it("keys a product the seller does not own by its raw id and leaves its label empty", async () => {
    respond([bucket({ product_id: 3 }, 500)]);

    const result = await salesSummary(seller, { from: "2026-11-01", to: "2026-11-02", groupBy: "product" });

    expect(result.breakdown).toEqual([
      { gross_cents: 500, net_cents: 500, units: 1, refunded_cents: 0, refunded_units: 0, key: "3", label: null },
    ]);
  });

  it("hands back product rows that tie on gross and label", async () => {
    respond([bucket({ product_id: 3 }, 500), bucket({ product_id: 4 }, 500)]);

    await expect(
      salesSummary(seller, { from: "2026-11-01", to: "2026-11-02", groupBy: "product" }),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a seller whose time zone is not mapped", async () => {
    await expect(
      salesSummary({ id: 7n, timezone: "Nowhere" }, { from: "2026-11-01", to: "2026-11-02", groupBy: null }),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });
});
