// Replays payout-note-retries-exhausted-jobs.golden.json (scripts/golden/payout-note-retries-exhausted-jobs.rb): the
// sidekiq_retries_exhausted blocks of HandleNewBankAccountWorker and DeleteGuardianStripePersonJob, run by the real app, and the part of
// HandleNewBankAccountWorker#perform Node runs. Node sends the statements Rails sent (the payout note insert with its version) and
// reports to Sentry the same things in the same order.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import {
  deleteGuardianStripePersonJobRetriesExhaustedWith,
  deleteGuardianStripePersonJobWith,
  handleNewBankAccountWorkerRetriesExhaustedWith,
  handleNewBankAccountWorkerWith,
} from "./payout-note-retries-exhausted-jobs.ts";

type Case = JobCase & {
  reaches_stripe?: boolean;
  hook?: boolean;
  job?: string;
  notified?: { args: (string | { class: string; message: string })[] }[];
};

const golden = loadGolden(
  new URL("./__fixtures__/payout-note-retries-exhausted-jobs.golden.json", import.meta.url),
) as unknown as {
  now: number;
  cases: Case[];
};
const nowDate = () => new Date(Math.round(golden.now * 1000));

const isInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value);
const isDigits = (value: unknown) => typeof value === "string" && /^[0-9]{1,15}$/u.test(value);

replayJobGolden(
  "HandleNewBankAccountWorker",
  {
    now: golden.now,
    cases: golden.cases.filter((c) => !c.hook).map((c) => ({ ...c, hands_back: Boolean(c.reaches_stripe) })),
  },
  handleNewBankAccountWorkerWith(),
  // Rails casts a float or a word and raises for nil; Node hands those arguments back before any statement.
  (c) => c.args.length >= 1 && c.args.length <= 2 && !(isInteger(c.args[0]) || isDigits(c.args[0])),
);

describe("DeleteGuardianStripePersonJob", () => {
  it("hands back before anything is read, as the Stripe call is the whole job", async () => {
    const sql = sqlReplay([]);
    await expect(
      deleteGuardianStripePersonJobWith()(["person_1", "acct_1", 1], contextFor(runtimeFor())),
    ).rejects.toMatchObject({
      name: "HandBackToRuby",
    });
    expect(sql.log).toEqual([]);
  });

  it("raises Ruby's ArgumentError for the wrong number of arguments", async () => {
    sqlReplay([]);
    await expect(deleteGuardianStripePersonJobWith()(["person_1", "acct_1"], contextFor(runtimeFor()))).rejects.toThrow(
      "wrong number of arguments (given 2, expected 3)",
    );
  });
});

function runtimeFor() {
  const recording = recordingSidekiqRedis();
  return createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

describe("sidekiq_retries_exhausted of the payout note jobs", () => {
  for (const c of golden.cases.filter((candidate) => candidate.hook)) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const notified: unknown[] = [];
      const deps = { now: nowDate, notify: (errorOrMessage: unknown) => notified.push(errorOrMessage) };
      const hook =
        c.job === "HandleNewBankAccountWorker"
          ? handleNewBankAccountWorkerRetriesExhaustedWith(deps)
          : deleteGuardianStripePersonJobRetriesExhaustedWith(deps);

      await asSidekiqJob(
        () => hook({ args: c.args } as unknown as SidekiqItem, new Error("boom"), { runtime: runtimeFor() }),
        golden.now,
      );

      expect(sql.log).toEqual(sql.expected);
      expect(notified.map((n) => (n instanceof Error ? n.message : n))).toEqual(
        c.notified!.map((n) => (typeof n.args[0] === "string" ? n.args[0] : n.args[0]!.message)),
      );
    });
  }

  it("keeps notifying when the breadcrumb cannot be written, as Ruby rescues it", async () => {
    sqlReplay([
      {
        sql: "SELECT `users`.* FROM `users` WHERE `users`.`id` = 1 LIMIT 1",
        result: { error: { number: 2013, message: "Lost connection to MySQL server during query" } },
      },
    ]);
    const notified: unknown[] = [];
    const hook = deleteGuardianStripePersonJobRetriesExhaustedWith({ now: nowDate, notify: (n) => notified.push(n) });
    await asSidekiqJob(
      () =>
        hook({ args: ["person_1", "acct_1", 1] } as unknown as SidekiqItem, new Error("boom"), {
          runtime: runtimeFor(),
        }),
      golden.now,
    );
    expect(notified).toHaveLength(2);
    expect(notified[0]).toBeInstanceOf(Error);
    expect(String(notified[1])).toContain("GDPR erasure incomplete");
  });
});
