// Replays compile-gumroad-daily-analytics-job.golden.json (scripts/golden/compile-gumroad-daily-analytics-job.rb):
// CompileGumroadDailyAnalyticsJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for each of the 46 days (the
// analytic lookup, the four aggregates, and the insert or update) and fails with the same error when a sum does not fit the integer column.
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
import { compileGumroadDailyAnalyticsJobWith } from "./compile-gumroad-daily-analytics-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/compile-gumroad-daily-analytics-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = compileGumroadDailyAnalyticsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

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
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("CompileGumroadDailyAnalyticsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const { error } = await run([1], []);

    expect(error).not.toBeNull();
  });
});
