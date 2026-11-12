// Replays refund-write.golden.json (scripts/golden/refund-write.rb): the Refund row as the real classes save it, `purchase.refunds << refund`
// and the later `save!` calls, against a scratch database. Node must send the statements Rails sent between the "refund" markers, in order,
// and answer the same for `<<` (an invalid refund is not inserted and nothing raises).
import type { Refund } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { appendRefund, assignRefundAttribute, Refunds } from "./refund.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";

type WriteCase = GoldenCase & {
  inserts: [string, unknown][];
  updates: [string, unknown][][];
  existing: boolean;
  appended: boolean;
};
const golden = loadGolden("refund-write.golden.json") as unknown as { now: Date; cases: WriteCase[] };

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
function seededRefund(c: WriteCase) {
  const row = c.seed.map(parseInsert).find((parsed) => parsed.table === "refunds")!.row;
  const typed = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v]),
  );
  return Refunds.load(castRow<Refund>("Refund", typed));
}

describe("Refund saves", () => {
  for (const c of golden.cases) {
    it(`sends the statements of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "refund");
      const sql = sqlReplay(span.filter(isSql));
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));
      const options = { now: () => golden.now };

      const appended = await withExecutor(async () => {
        const refund = c.existing ? seededRefund(c) : Refunds.build({});
        let result = true;
        if (!c.existing) {
          for (const [key, value] of c.inserts) assignRefundAttribute(refund, key, value);
          result = await appendRefund(purchase, refund, options);
        }
        for (const batch of c.updates) {
          for (const [key, value] of batch) assignRefundAttribute(refund, key, value);
          await Refunds.saveBang(refund, options);
        }
        return result;
      });

      expect(sql.log).toEqual(expected);
      if (!c.existing) expect(appended).toBe(c.appended);
    });
  }
});
