// Replays purchase-affiliate-balance.golden.json (scripts/golden/purchase-affiliate-balance.rb): the real
// Purchase#increment_sellers_balance! for a sale that credits a DirectAffiliate. Node must send the statements Rails sent between
// the "increment" markers, make the Flipper reads and push the jobs in the same order, and hand a collaborator back before a write.
//
// One deliberate difference: Node reads the purchase's presentment before it credits the affiliate (Ruby reads it afterwards, in the
// seller's share), so that a presentment is refused before the first write. The replay moves that one SELECT to the front.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type Entry } from "./__fixtures__/paid-sale-golden.ts";
import { withContext } from "./purchase-create.ts";
import { incrementSellersBalanceBang } from "./purchase-seller-balance.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";
import { NotPortedError } from "./user.ts";

const golden = loadGolden("purchase-affiliate-balance.golden.json");

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

const PRESENTMENT = "FROM `purchase_presentments`";
const label = (entry: Entry) =>
  isSql(entry) ? entry.sql : "job" in entry ? `JOB ${entry.job}` : "flipper" in entry ? `FLIPPER ${entry.flipper}` : "";

// The span with the presentment SELECT moved ahead of the affiliate's first statement, where Node reads it.
function nodeOrder(span: Entry[]): Entry[] {
  if (!span.some((entry) => isSql(entry) && entry.sql.includes("FROM `affiliates`"))) return span;
  const index = span.findIndex((entry) => isSql(entry) && entry.sql.includes(PRESENTMENT));
  if (index < 0) return span;
  return [span[index]!, ...span.slice(0, index), ...span.slice(index + 1)];
}

const COLLABORATOR = "a collaborator's credit";

describe("Purchase#increment_sellers_balance! with an affiliate", () => {
  for (const c of golden.cases.filter((candidate) => candidate.name !== COLLABORATOR)) {
    it(`sends the statements, Flipper reads and jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "increment");
      const ordered = nodeOrder(span).filter((entry) => !("marker" in entry));
      const sql = sqlReplay(ordered.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const flips = span.filter((entry): entry is Extract<Entry, { flipper: string }> => "flipper" in entry);
      withContext(purchase, {
        ...(purchase.ivars.context as object),
        effects: {
          featureActive: (name: string) => {
            sql.log.push(`FLIPPER ${name}`);
            return Promise.resolve(flips.find((flip) => flip.flipper === name)?.result ?? false);
          },
        },
      } as never);

      // The recording ran in rails runner, which has no query cache: Ruby reads affiliates_links twice, a cached request once.
      await withExecutor(() =>
        uncached(() => incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => golden.now })),
      );

      expect(sql.log).toEqual(ordered.map(label));
      expect(purchase.get("purchase_success_balance_id")).toBe(c.purchase_success_balance_id);
    });
  }

  it("hands back a collaborator's credit before it sends a write", async () => {
    const c = golden.cases.find((candidate) => candidate.name === COLLABORATOR)!;
    const { span, purchase } = setupSale(c, "increment");
    const sql = sqlReplay(nodeOrder(span).filter(isSql));

    const error = await withExecutor(() =>
      incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => golden.now }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotPortedError);
    expect((error as Error).message).toContain("Collaborator");
    expect(sql.log.filter((statement) => !statement.startsWith("SELECT"))).toEqual([]);
  });
});
