// Replays refresh-high-volume-seller-fee-eligibility-job.golden.json (scripts/golden/refresh-high-volume-seller-fee-eligibility-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the same two statements for the nightly sweep and enqueues the same
// per-seller jobs, once each, qualifying sellers first. A seller id that matches a user is handed back after the lookup.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { refreshHighVolumeSellerFeeEligibilityJobWith } from "./refresh-high-volume-seller-fee-eligibility-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/refresh-high-volume-seller-fee-eligibility-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };
const handler = refreshHighVolumeSellerFeeEligibilityJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Rails refreshes the user it finds, which saves it with callbacks Node does not run.
const HAND_BACK = new Set(["a seller id refreshes that seller", "a seller id given as a digit string"]);

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

describe("RefreshHighVolumeSellerFeeEligibilityJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, 1));
        expect(recording.snapshot()).toEqual({});
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
        expect(recording.snapshot()).toEqual(c.redis);
      }
    });
  }

  for (const arg of [true, "abc", [1], { a: 1 }, 1.5, " "] as JsonValue[]) {
    it(`hands the argument ${JSON.stringify(arg)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const { runtime: jobs } = runtime();
      await expect(asSidekiqJob(() => handler([arg], contextFor(jobs)), golden.now)).rejects.toMatchObject({
        name: "HandBackToRuby",
      });
      expect(sql.log).toEqual([]);
    });
  }

  it("rejects two arguments, as perform takes at most one", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    await expect(asSidekiqJob(() => handler([1, 2], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
