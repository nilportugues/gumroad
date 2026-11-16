// Replays release-chargeback-rate-payout-pause-for-seller-job.golden.json (scripts/golden/release-chargeback-rate-payout-pause-for-seller-job.rb):
// ReleaseChargebackRatePayoutPauseForSellerJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for every exit
// before the lock: the user, the pause comment, the chargeback-rate aggregate. A hold that would be lifted (a rate within the limit) is handed
// back right before the lock's BEGIN, with nothing written. An id Rails casts (a float, a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { releaseChargebackRatePayoutPauseForSellerJobWith } from "./release-chargeback-rate-payout-pause-for-seller-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  at: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/release-chargeback-rate-payout-pause-for-seller-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

const CAST_IDS = new Set(["a user id given as a float", "a user id given as a word"]);
// Rails opens the lock's transaction here; Node hands the job back before it.
const lockIndex = (c: Case) => c.statements.findIndex((s) => s.sql === "BEGIN");

async function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  const handler = releaseChargebackRatePayoutPauseForSellerJobWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("ReleaseChargebackRatePayoutPauseForSellerJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && lockIndex(c) === -1)) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && lockIndex(c) !== -1)) {
    it(`hands ${c.name} back before the lock`, async () => {
      const { sql, recording, error } = await run(c.args, c.statements.slice(0, lockIndex(c)));

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
