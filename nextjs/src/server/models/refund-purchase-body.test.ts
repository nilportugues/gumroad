// Replays refund-purchase-body.golden.json (scripts/golden/refund-purchase-body.rb): the real Purchase#refund_purchase! from the lock to the
// VAT credit, stopped where Ruby would notify the seller's webhook. Node must send the statements Rails sent (the stop rolls the
// transaction back), push the same jobs with the same arguments, and answer what Ruby answers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { refundPurchaseBodyBang } from "./refund-purchase-body.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";
import { NotPortedError } from "./user.ts";

type BodyCase = GoldenCase & {
  returned: string;
  refunding_user_id: number;
  is_for_fraud: boolean;
  note: string | null;
  gumroad_funded: boolean;
  balance_reconciliation_needed: boolean;
  stripe_refund: { id: string; status: string } | null;
};
const golden = loadGolden("refund-purchase-body.golden.json") as unknown as { now: Date; cases: BodyCase[] };

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

class Stop extends Error {}

function argumentsOf(c: BodyCase) {
  return {
    flowOfFunds: flowOf(c),
    refundingUserId: c.refunding_user_id,
    stripeRefund: c.stripe_refund,
    isForFraud: c.is_for_fraud,
    note: c.note,
    gumroadFunded: c.gumroad_funded,
    balanceReconciliationNeeded: c.balance_reconciliation_needed,
  };
}

// The managed-account sale collects its retained fee from Stripe after commit, which is not ported: the body refuses it.
const REFUSED = new Map([
  [
    "a refund for fraud of a sale whose VAT was refunded on its own, on an account Gumroad manages",
    "a Stripe transfer reversal for a sale whose VAT was already refunded",
  ],
  ["a refund of a sale on an account Gumroad manages for the seller", "a retained fee collected from Stripe"],
  [
    "a partial refund of a sale whose VAT was refunded on its own, on an account Gumroad manages",
    "a Stripe transfer reversal for a sale whose VAT was already refunded",
  ],
]);

describe("Purchase#refund_purchase! up to the seller's webhook", () => {
  for (const c of golden.cases.filter((candidate) => !REFUSED.has(candidate.name))) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "refund");
      const sql = sqlReplay(span.filter(isSql));
      const pushed: unknown[] = [];
      onJob = (jobClass, args) => {
        sql.log.push(`JOB ${jobClass}`);
        pushed.push(args);
      };
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));
      const jobArgs = span.flatMap((entry) => ("job" in entry ? [(entry as unknown as { args: unknown }).args] : []));

      const result = await withExecutor(() =>
        uncached(() =>
          refundPurchaseBodyBang(purchase, argumentsOf(c), () => Promise.reject(new Stop()), { now: () => golden.now }),
        ),
      ).then(
        (answer) => answer,
        (error: unknown) => error,
      );

      if (result instanceof Error && !(result instanceof Stop)) expect(sql.log).toEqual(expected);
      expect(JSON.parse(JSON.stringify(pushed, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)))).toEqual(
        jobArgs,
      );
      expect(c.returned === "stopped" ? result instanceof Stop : result).toBe(
        c.returned === "stopped" ? true : c.returned === "true",
      );
    });
  }

  for (const [name, reason] of REFUSED) {
    it(`hands back ${name} after rolling its writes back`, async () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const { span, purchase } = setupSale(c, "refund");
      sqlReplay(span.filter(isSql));

      const error = await withExecutor(() =>
        uncached(() =>
          refundPurchaseBodyBang(purchase, argumentsOf(c), () => Promise.resolve(true), { now: () => golden.now }),
        ),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotPortedError);
      expect((error as Error).message).toContain(reason);
    });
  }

  for (const [what, change, message] of [
    [
      "a chargeback",
      (p: ReturnType<typeof setupSale>["purchase"]) => p.set("chargeback_date", new Date() as never),
      "a chargeback",
    ],
    [
      "another processor",
      (p: ReturnType<typeof setupSale>["purchase"]) => p.set("charge_processor_id", "braintree" as never),
      "other than Stripe",
    ],
  ] as const) {
    it(`hands back ${what} before it sends a statement`, async () => {
      const c = golden.cases[0]!;
      const { purchase } = setupSale(c, "refund");
      change(purchase);
      const sql = sqlReplay([]);

      const error = await withExecutor(() =>
        refundPurchaseBodyBang(purchase, argumentsOf(c), () => Promise.resolve(true), { now: () => golden.now }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotPortedError);
      expect((error as Error).message).toContain(message);
      expect(sql.log).toEqual([]);
    });
  }
});
