// Replays reconcile-stripe-payouts-pause-for-seller-job.golden.json (scripts/golden/reconcile-stripe-payouts-pause-for-seller-job.rb):
// ReconcileStripePayoutsPauseForSellerJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for every exit before
// Stripe: the user, the resume and hold comments, the merchant accounts. A seller whose pause reaches `Stripe::Account.retrieve` (`hands_back`
// in the golden) is handed back right before it, with nothing written. An id Rails casts (a float, a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { reconcileStripePayoutsPauseForSellerJobWith } from "./reconcile-stripe-payouts-pause-for-seller-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/reconcile-stripe-payouts-pause-for-seller-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };

const CAST_IDS = new Set(["a user id as a float", "a user id as a word"]);

async function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = reconcileStripePayoutsPauseForSellerJobWith();
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("ReconcileStripePayoutsPauseForSellerJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !c.hands_back)) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.hands_back)) {
    it(`hands ${c.name} back before Stripe`, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, error } = await run(c.args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { error } = await run([], []);

    expect(error).not.toBeNull();
  });
});
