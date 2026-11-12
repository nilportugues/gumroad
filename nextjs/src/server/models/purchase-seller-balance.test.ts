// Replays purchase-seller-balance.golden.json (scripts/golden/purchase-seller-balance.rb): the real Purchase#increment_sellers_balance!
// against a scratch database. Node must send the statements Rails sent between the "increment" markers, push the same jobs, and
// refuse (before any statement that writes) the shapes it does not serve.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale } from "./__fixtures__/paid-sale-golden.ts";
import { incrementSellersBalanceBang } from "./purchase-seller-balance.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { NotPortedError } from "./user.ts";

const golden = loadGolden("purchase-seller-balance.golden.json");

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

const REFUSED = new Map([
  ["a sale with a buyer-currency presentment", "a buyer-currency presentment"],
  ["a purchase with no merchant account is Stripe's and books", "no merchant account"],
]);

describe("Purchase#increment_sellers_balance!", () => {
  for (const c of golden.cases.filter((candidate) => !REFUSED.has(candidate.name))) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "increment");
      const sql = sqlReplay(span.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));

      await withExecutor(() =>
        incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
      );

      expect(sql.log).toEqual(expected);
      expect(purchase.get("purchase_success_balance_id")).toBe(c.purchase_success_balance_id);
    });
  }

  for (const [name, reason] of REFUSED) {
    it(`hands back ${name} before it sends a write`, async () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const { span, purchase } = setupSale(c, "increment");
      const sql = sqlReplay(span.filter(isSql));

      const error = await withExecutor(() =>
        incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotPortedError);
      expect((error as Error).message).toContain(reason);
      expect(sql.log.filter((statement) => !statement.startsWith("SELECT"))).toEqual([]);
    });
  }
});
