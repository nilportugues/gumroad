import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));

import { NotPortedError } from "../not-ported.ts";

import { blackFridayStats } from "./black-friday-stats.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);
const code = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  valid_at: null,
  expires_at: null,
  amount_percentage: null,
  ownership_duration_tiers: null,
  ...fields,
});

function database(offerCodes: ReturnType<typeof code>[], revenue: unknown = 0) {
  selectRows.mockImplementation((query: Prisma.Sql) =>
    Promise.resolve(query.strings.join("?").includes("FROM `offer_codes`") ? offerCodes : [{ revenue }]),
  );
}
const sqlOf = (call: number) => (selectRows.mock.calls[call]![0] as Prisma.Sql).strings.join("?");

beforeEach(() => {
  selectRows.mockReset();
});

describe("blackFridayStats", () => {
  it("answers zeros without reading purchases when no code is alive", async () => {
    database([]);
    expect(await blackFridayStats("BLACKFRIDAY2025", NOW)).toEqual({
      active_deals_count: 0,
      revenue_cents: 0,
      average_discount_percentage: 0,
    });
    expect(selectRows).toHaveBeenCalledTimes(1);
  });

  it("reads only the alive codes with the Black Friday code", async () => {
    database([]);
    await blackFridayStats("BLACKFRIDAY2025", NOW);
    expect(sqlOf(0)).toContain("`offer_codes`.`code` = ?");
    expect(sqlOf(0)).toContain("`offer_codes`.`deleted_at` IS NULL");
  });

  it("averages the percentages with Ruby's half-away rounding, a fixed-amount code counting as a deal only", async () => {
    database([
      code(1, { amount_percentage: 25 }),
      code(2, {
        amount_percentage: 0,
        ownership_duration_tiers: [
          { months: 0, amount_percentage: 10 },
          { months: 12, amount_percentage: 60 },
        ],
      }),
      code(3),
    ]);
    const stats = await blackFridayStats("BLACKFRIDAY2025", NOW);
    expect(stats.active_deals_count).toBe(3);
    expect(stats.average_discount_percentage).toBe(43);
  });

  it("keeps a 0 percent code in the average", async () => {
    database([code(1, { amount_percentage: 0 }), code(2, { amount_percentage: 25 })]);
    expect((await blackFridayStats("BLACKFRIDAY2025", NOW)).average_discount_percentage).toBe(13);
  });

  it("drops codes that have expired or not started from the deals and the average but keeps their revenue", async () => {
    database(
      [
        code(1, { amount_percentage: 20 }),
        code(2, { amount_percentage: 80, expires_at: day(-1) }),
        code(3, { amount_percentage: 80, valid_at: day(1) }),
      ],
      "950",
    );
    expect(await blackFridayStats("BLACKFRIDAY2025", NOW)).toEqual({
      active_deals_count: 1,
      revenue_cents: 950,
      average_discount_percentage: 20,
    });
    expect(sqlOf(1)).toContain("`purchases`.`offer_code_id` IN (?,?,?)");
  });

  it("counts only statistics purchases", async () => {
    database([code(1, { amount_percentage: 20 })]);
    await blackFridayStats("BLACKFRIDAY2025", NOW);
    expect(sqlOf(1)).toContain("`purchase_state` IN");
    expect(sqlOf(1)).toContain("subscription_id IS NULL");
  });

  it("raises NotPortedError for tiers it cannot read", async () => {
    database([code(1, { ownership_duration_tiers: { months: 0 } })]);
    await expect(blackFridayStats("BLACKFRIDAY2025", NOW)).rejects.toBeInstanceOf(NotPortedError);
  });
});
