// Replays refund-purchase-tail.golden.json (scripts/golden/refund-purchase-body.rb, `full`): the real Purchase#refund_purchase! to its end,
// committed. Node must send the statements Rails sent, push the jobs (and the buyer's mail) it pushed with the same arguments and delays.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { refundPurchaseBang } from "./refund-purchase-tail.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";

type TailCase = GoldenCase & {
  returned: string;
  refunding_user_id: number;
  is_for_fraud: boolean;
  note: string | null;
  gumroad_funded: boolean;
  balance_reconciliation_needed: boolean;
  stripe_refund: { id: string; status: string } | null;
};
const golden = loadGolden("refund-purchase-tail.golden.json") as unknown as { now: Date; cases: TailCase[] };

type Pushed = { name: string; args: unknown; delay: number | null };
let pushed: Pushed[] = [];
let logSink: string[] = [];

vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  currentJobsRuntime: () => ({}) as never,
  performAsync: vi.fn((jobClass: string, args: unknown, options?: { delaySeconds?: number }) => {
    // sidekiq-unique-jobs (lock: :until_executing) drops a second push of the product refresh within a transaction
    if (jobClass === "SendToElasticsearchWorker" && pushed.some((p) => p.name === jobClass))
      return Promise.resolve(null);
    logSink.push(`JOB ${jobClass}`);
    pushed.push({ name: jobClass, args, delay: options?.delaySeconds ?? null });
    return Promise.resolve("jid");
  }),
}));
vi.mock("../mail/active-job.ts", async (importActual) => ({
  ...(await importActual<typeof import("../mail/active-job.ts")>()),
  deliverLater: vi.fn((_runtime: unknown, input: { mailer: string; method: string; args: unknown[] }) => {
    logSink.push("JOB MailDeliveryJob");
    pushed.push({ name: "MailDeliveryJob", args: [input.mailer, input.method, input.args], delay: null });
    return Promise.resolve();
  }),
}));

const notified: unknown[] = [];
vi.mock("../infra/error-reporting.ts", () => ({
  notifyError: vi.fn((message: string, context: unknown) => notified.push({ message, context })),
}));

beforeAll(() => {
  // .env.test of the recording
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});
afterEach(() => {
  pushed = [];
  notified.length = 0;
});

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)));

describe("Purchase#refund_purchase! to its end", () => {
  // a bundle's licences are handed back
  for (const c of golden.cases.filter((candidate) => candidate.error === null && !candidate.name.includes("bundle"))) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "refund");
      const entries = span.filter((entry) => !("marker" in entry) && !("flipper" in entry));
      const sql = sqlReplay(span.filter(isSql));
      logSink = sql.log;
      const nowSeconds = golden.now.getTime() / 1000;
      const expectedJobs = entries.flatMap((entry) => {
        if (!("job" in entry)) return [];
        const job = entry as unknown as { job: string; args: unknown[]; at: number | null };
        const delay = job.at === null ? null : Math.round(job.at - nowSeconds);
        if (job.job !== "MailDeliveryJob") return [{ name: job.job, args: job.args, delay }];
        const wrapped = job.args[0] as { arguments: [string, string, string, { args: unknown[] }] };
        return [
          { name: job.job, args: [wrapped.arguments[0], wrapped.arguments[1], wrapped.arguments[3].args], delay },
        ];
      });
      const expectedLog = entries.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));

      const result = await withExecutor(() =>
        uncached(() =>
          refundPurchaseBang(
            purchase,
            {
              flowOfFunds: flowOf(c),
              refundingUserId: c.refunding_user_id,
              stripeRefund: c.stripe_refund,
              isForFraud: c.is_for_fraud,
              note: c.note,
              gumroadFunded: c.gumroad_funded,
              balanceReconciliationNeeded: c.balance_reconciliation_needed,
            },
            { now: () => golden.now },
          ),
        ),
      );

      expect(result).toBe(c.returned === "true");
      expect(sql.log).toEqual(expectedLog);
      expect(plain(pushed)).toEqual(plain(expectedJobs));
    });
  }

  it("hands back a bundle before it sends a statement", async () => {
    const c = golden.cases.find((candidate) => candidate.name.includes("bundle"))!;
    const { purchase } = setupSale(c, "refund");
    const sql = sqlReplay([]);
    const error = await withExecutor(() =>
      refundPurchaseBang(
        purchase,
        { flowOfFunds: flowOf(c), refundingUserId: c.refunding_user_id, stripeRefund: c.stripe_refund },
        { now: () => golden.now },
      ),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("a bundle's licences");
    expect(sql.log).toEqual([]);
  });
});
