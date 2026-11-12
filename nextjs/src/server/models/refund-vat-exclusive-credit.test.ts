// Replays refund-vat-exclusive-credit.golden.json (scripts/golden/refund-vat-exclusive-credit.rb): the real
// Credit.create_for_vat_exclusive_refund! against a scratch database. Node must send the statements Rails sent between the "vat"
// markers, push the same jobs, and return what Ruby returns (nil when the refund returned the VAT or the sale charged none).
import type { Refund } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { createForVatExclusiveRefundBang } from "./refund-vat-exclusive-credit.ts";
import { Refunds } from "./refund.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";

type RetentionCase = GoldenCase & {
  credit_id: number | null;
  credit_balance_id: number | null;
  credit_amount_cents: number | null;
};
const golden = loadGolden("refund-vat-exclusive-credit.golden.json") as unknown as {
  now: Date;
  cases: RetentionCase[];
};

let onJob: (jobClass: string) => void = () => {};
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  performAsync: vi.fn((jobClass: string) => {
    onJob(jobClass);
    return Promise.resolve("jid");
  }),
}));

afterEach(() => {
  onJob = () => {};
});

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
function refundOf(c: RetentionCase) {
  const row = c.seed.map(parseInsert).find((parsed) => parsed.table === "refunds")!.row;
  const typed = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );
  return Refunds.load(castRow<Refund>("Refund", typed));
}

describe("Credit.create_for_vat_exclusive_refund!", () => {
  for (const c of golden.cases) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "vat");
      const sql = sqlReplay(span.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));
      const refund = refundOf(c);
      assignBelongsTo(
        refund,
        { name: "purchase", foreignKey: "purchase_id", targetTable: "purchases", targetModel: "Purchase" },
        purchase,
      );

      // The golden ran as a model method does outside any executor: with the query cache off.
      const credit = await withExecutor(() =>
        uncached(() => createForVatExclusiveRefundBang(purchase, refund, { now: () => golden.now })),
      );

      expect(sql.log).toEqual(expected);
      expect(credit === null ? null : Number(credit.get("id"))).toBe(c.credit_id);
      expect(credit === null ? null : Number(credit.get("balance_id") ?? NaN) || null).toBe(c.credit_balance_id);
      expect(credit === null ? null : credit.get("amount_cents")!).toBe(c.credit_amount_cents);
    });
  }
});
