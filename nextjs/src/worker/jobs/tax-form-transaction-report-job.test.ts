// Replays tax-form-transaction-report-job.golden.json (scripts/golden/tax-form-transaction-report-job.rb): the job run by the real app as
// a Sidekiq job, and the block of its sidekiq_retries_exhausted. Node sends the statements Rails sent up to the Stripe report (or up to
// the fallback to the seller's own Stripe account) and hands back there; the exhausted block notifies with the job's user and year.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import {
  taxFormTransactionReportJobRetriesExhaustedWith,
  taxFormTransactionReportJobWith,
} from "./tax-form-transaction-report-job.ts";

type Case = JobCase & { reaches_report?: boolean; node_hands_back?: boolean; hook?: boolean; notified?: Notified[] };
type Notified = { args: { class: string; message: string }[]; kwargs: Record<string, unknown> };

const golden = loadGolden(
  new URL("./__fixtures__/tax-form-transaction-report-job.golden.json", import.meta.url),
) as unknown as {
  now: number;
  cases: Case[];
};
const runs = golden.cases.filter((c) => !c.hook);

const isInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value);
const isDigits = (value: unknown) => typeof value === "string" && /^[0-9]{1,9}$/u.test(value);
// Rails casts a float or a word and raises for nil; Node hands those arguments back before any statement.
const castByRails = (c: JobCase) =>
  !((isInteger(c.args[0]) || isDigits(c.args[0])) && (isInteger(c.args[1]) || isDigits(c.args[1])));

replayJobGolden(
  "TaxFormTransactionReportJob",
  {
    now: golden.now,
    cases: runs.map((c) => ({ ...c, hands_back: Boolean(c.reaches_report || c.node_hands_back) })),
  },
  taxFormTransactionReportJobWith(),
  (c) => c.args.length === 2 && castByRails(c),
);

describe("TaxFormTransactionReportJob, sidekiq_retries_exhausted", () => {
  for (const c of golden.cases.filter((candidate) => candidate.hook)) {
    it(c.name, async () => {
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const notified: Notified[] = [];
      const hook = taxFormTransactionReportJobRetriesExhaustedWith({
        notify: (error, context) =>
          notified.push({ args: [{ class: "", message: (error as Error).message }], kwargs: context }),
      });
      const error = new Error(c.notified![0]!.args[0]!.message);
      await hook({ args: c.args } as unknown as SidekiqItem, error, { runtime });

      expect(notified.map((n) => ({ message: n.args[0]!.message, kwargs: n.kwargs }))).toEqual(
        c.notified!.map((n) => ({ message: n.args[0]!.message, kwargs: n.kwargs })),
      );
    });
  }
});
