// Replays refund-seller-balance.golden.json (scripts/golden/refund-seller-balance.rb): the real
// Purchase#process_refund_or_chargeback_for_purchase_balance for a refund against a scratch database. Node must send the statements
// Rails sent between the "refund" markers, push the same jobs, and refuse (before any statement that writes) the shapes it does not serve.
import type { Refund } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { processRefundForPurchaseBalanceBang } from "./refund-seller-balance.ts";
import { Refunds } from "./refund.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type RefundCase = GoldenCase & { refund_cents: number; purchase_refund_balance_id: number | null };
const golden = loadGolden("refund-seller-balance.golden.json") as unknown as { now: Date; cases: RefundCase[] };

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

const REFUSED = new Map([["a refund of a sale with a buyer-currency presentment", "a buyer-currency presentment"]]);

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
function refundOf(c: RefundCase) {
  const row = c.seed.map(parseInsert).find((parsed) => parsed.table === "refunds")!.row;
  const typed = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );
  return Refunds.load(castRow<Refund>("Refund", typed));
}

describe("Purchase#process_refund_or_chargeback_for_purchase_balance for a refund", () => {
  for (const c of golden.cases.filter((candidate) => !REFUSED.has(candidate.name))) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "refund");
      const sql = sqlReplay(span.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));

      await withExecutor(() =>
        processRefundForPurchaseBalanceBang(
          purchase,
          refundOf(c),
          { flowOfFunds: flowOf(c), refundCents: c.refund_cents },
          { now: () => golden.now },
        ),
      );

      expect(sql.log).toEqual(expected);
      expect(purchase.get("purchase_refund_balance_id") ?? null).toBe(c.purchase_refund_balance_id);
    });
  }

  for (const [name, reason] of REFUSED) {
    it(`hands back ${name} before it sends a write`, async () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const { span, purchase } = setupSale(c, "refund");
      const sql = sqlReplay(span.filter(isSql));

      const error = await withExecutor(() =>
        processRefundForPurchaseBalanceBang(
          purchase,
          refundOf(c),
          { flowOfFunds: flowOf(c), refundCents: c.refund_cents },
          { now: () => golden.now },
        ),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotPortedError);
      expect((error as Error).message).toContain(reason);
      expect(sql.log.filter((statement) => !statement.startsWith("SELECT"))).toEqual([]);
    });
  }
});
