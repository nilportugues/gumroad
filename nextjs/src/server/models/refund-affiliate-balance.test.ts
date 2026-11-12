// Replays refund-affiliate-balance.golden.json (scripts/golden/refund-affiliate-balance.rb): the real
// Purchase#decrement_balance_for_refund_or_chargeback! for a refund of a sale that credits an affiliate, against a scratch database.
// Node must send the statements Rails sent between the "decrement" markers, push the same jobs, and refuse the shapes it holds no
// recording of before a write.
import type { Refund } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { decrementBalanceForRefundBang } from "./refund-affiliate-balance.ts";
import { Refunds } from "./refund.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type DecrementCase = GoldenCase & { partially_refunded: boolean; refund_id: number };
const golden = loadGolden("refund-affiliate-balance.golden.json") as unknown as { now: Date; cases: DecrementCase[] };

let onJob: (jobClass: string, args: unknown) => void = () => {};
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  performAsync: vi.fn((jobClass: string, args: unknown) => {
    onJob(jobClass, args);
    return Promise.resolve("jid");
  }),
}));

afterEach(() => {
  onJob = () => {};
});

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
function refundOf(c: DecrementCase) {
  const row = c.seed
    .map(parseInsert)
    .find((parsed) => parsed.table === "refunds" && Number(parsed.row.id) === c.refund_id)!.row;
  const typed = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );
  return Refunds.load(castRow<Refund>("Refund", typed));
}

// refund_purchase! has set the new flags in memory when it gets here
function withFlags(c: DecrementCase) {
  const { span, purchase } = setupSale(c, "decrement");
  purchase.set("stripe_partially_refunded", c.partially_refunded);
  purchase.set("stripe_refunded", !c.partially_refunded);
  return { span, purchase };
}

describe("Purchase#decrement_balance_for_refund_or_chargeback! for a refund", () => {
  for (const c of golden.cases) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = withFlags(c);
      const sql = sqlReplay(span.filter(isSql));
      const pushed: unknown[] = [];
      onJob = (jobClass, args) => {
        sql.log.push(`JOB ${jobClass}`);
        pushed.push(args);
      };
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));
      const jobArgs = span.flatMap((entry) => ("job" in entry ? [(entry as unknown as { args: unknown }).args] : []));

      const failure = await withExecutor(() =>
        uncached(() =>
          decrementBalanceForRefundBang(purchase, refundOf(c), { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(sql.log).toEqual(expected);
      expect(failure).toBeNull();
      expect(JSON.parse(JSON.stringify(pushed, (_, v) => (typeof v === "bigint" ? Number(v) : v)))).toEqual(jobArgs);
    });
  }

  it("hands back a purchase that carries a chargeback balance before it reads anything", async () => {
    const c = golden.cases[0]!;
    const { purchase } = withFlags(c);
    purchase.set("purchase_chargeback_balance_id", 99 as never);
    const sql = sqlReplay([]);

    const error = await withExecutor(() =>
      decrementBalanceForRefundBang(purchase, refundOf(c), { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotPortedError);
    expect(sql.log).toEqual([]);
  });

  it("hands back a collaborator's direct affiliate rate that the purchase never stored before a write", async () => {
    const c = golden.cases.find(
      (candidate) => candidate.name === "a collaborator beside a direct affiliate, partially refunded",
    )!;
    const { span, purchase } = withFlags(c);
    const json = JSON.parse(purchase.get("json_data") as string) as Record<string, unknown>;
    delete json.direct_affiliate_basis_points;
    purchase.set("json_data", JSON.stringify(json) as never);
    // the two affiliate lookups and the two credits are read, then the rate is refused
    const reads = span.filter(isSql).slice(0, 4);
    const sql = sqlReplay(reads);

    const error = await withExecutor(() =>
      uncached(() =>
        decrementBalanceForRefundBang(purchase, refundOf(c), { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
      ),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotPortedError);
    expect(sql.log).toEqual(reads.map((entry) => entry.sql));
  });
});
