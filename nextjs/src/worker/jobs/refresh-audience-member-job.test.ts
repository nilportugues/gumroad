// Replays refresh-audience-member-job.golden.json (scripts/golden/refresh-audience-member-job.rb): RefreshAudienceMemberJob run by
// the real app as a Sidekiq job. Node sends the statements Rails sent (the row lock, the sources, the save or destroy), enqueues the
// same Elasticsearch job and fails with the same error; every source (purchase, follower, direct affiliate) is recorded for real.
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
import { refreshAudienceMemberJobWith } from "./refresh-audience-member-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/refresh-audience-member-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = refreshAudienceMemberJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

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

describe("RefreshAudienceMemberJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements, { parseJsonOf: ["audience_members"] });
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const args of [
    [],
    ["buyer@example.com"],
    [null, 1],
    ["buyer@example.com", "1"],
    ["buyer@example.com", null],
    ["buyer@example.com", 1.5],
  ] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const { runtime: jobs } = runtime();
      const outcome = asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now);
      if (args.length < 2) await expect(outcome).rejects.toThrow("wrong number of arguments");
      else await expect(outcome).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(sql.log).toEqual([]);
    });
  }
});
