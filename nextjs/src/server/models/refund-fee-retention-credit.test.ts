// Replays refund-fee-retention-credit.golden.json (scripts/golden/refund-fee-retention-credit.rb): the real
// Credit.create_for_refund_fee_retention! against a scratch database. Node must send the statements Rails sent between the "retention"
// markers, push the same jobs, and return what Ruby returns (nil for a Connect sale with no tax and no affiliate share).
import type { Refund } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { setCurrencyDepsForTesting } from "./concerns/currency-helper.ts";
import { createForRefundFeeRetentionBang } from "./refund-fee-retention-credit.ts";
import { Refunds } from "./refund.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";

type RetentionCase = GoldenCase & { credit_id: number | null; credit_balance_id: number | null };
const golden = loadGolden("refund-fee-retention-credit.golden.json") as unknown as {
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
  setCurrencyDepsForTesting(undefined);
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

describe("Credit.create_for_refund_fee_retention!", () => {
  for (const c of golden.cases) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      // The rate the Ruby case seeded in Redis
      setCurrencyDepsForTesting({
        redis: () =>
          ({
            get: (key: string) => Promise.resolve(key.endsWith("CAD") ? "1.35" : null),
            set: () => Promise.resolve("OK"),
          }) as never,
      });
      const { span, purchase } = setupSale(c, "retention");
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
        uncached(() => createForRefundFeeRetentionBang(purchase, refund, { now: () => golden.now })),
      );

      expect(sql.log).toEqual(expected);
      expect(credit === null ? null : Number(credit.get("id"))).toBe(c.credit_id);
      expect(credit === null ? null : Number(credit.get("balance_id") ?? NaN) || null).toBe(c.credit_balance_id);
    });
  }
});
