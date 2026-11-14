// Replays expire-transcoded-videos-job.golden.json (scripts/golden/expire-transcoded-videos-job.rb): ExpireTranscodedVideosJob run
// by the real app as a Sidekiq job. Node reads the same Redis limit, checks replica lag before each batch, sends the statements
// Rails sent (the batch query, then each video's validated update with its PaperTrail version) and hands the job back, before
// it writes that video, at the first one with a streamable file.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { expireTranscodedVideosJobWith } from "./expire-transcoded-videos-job.ts";

const LIMIT_KEY = "transcoded_videos_recentness_limit_in_months";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis_before?: RedisSnapshot;
  replica_lag_watches: number;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/expire-transcoded-videos-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

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

// Just the `get` the job makes; any other command throws, so a write cannot pass unnoticed.
function limitRedis(limit: string | null) {
  const reads: string[] = [];
  return { reads, redis: { get: (key: string) => (reads.push(key), Promise.resolve(limit)) } };
}

function perform(limit: string | null) {
  const sql = sqlReplay([]);
  const fake = limitRedis(limit);
  let watches = 0;
  const handler = expireTranscodedVideosJobWith(
    {
      now,
      watchReplicaLag: () => {
        watches += 1;
        return Promise.resolve();
      },
    },
    { redis: () => fake.redis },
  );
  const { runtime: jobs } = runtime();
  return {
    sql,
    fake,
    watches: () => watches,
    run: () => asSidekiqJob(() => handler([], contextFor(jobs)), golden.now),
  };
}

describe("ExpireTranscodedVideosJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const limit = c.redis_before?.[LIMIT_KEY]?.value;
      const sql = sqlReplay(c.statements);
      const fake = limitRedis(typeof limit === "string" ? limit : null);
      let watches = 0;
      const handler = expireTranscodedVideosJobWith(
        {
          now,
          watchReplicaLag: () => {
            watches += 1;
            return Promise.resolve();
          },
        },
        { redis: () => fake.redis },
      );
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      }
      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_lag_watches);
      expect(fake.reads).toEqual([LIMIT_KEY]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const limit of ["1001000", "-1001000", "99999999999999999999"]) {
    it(`hands a limit of ${limit} months back before any statement or lag check`, async () => {
      const job = perform(limit);
      await expect(job.run()).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(job.sql.log).toEqual([]);
      expect(job.watches()).toBe(0);
    });
  }

  it("does not hand back a limit of 12000 months, the largest it runs", async () => {
    const job = perform("12000");
    // sqlReplay([]) has no statement to answer the batch query with, so the run stops there, after the lag check.
    await job.run().catch(() => undefined);
    expect(job.watches()).toBe(1);
  });
});
