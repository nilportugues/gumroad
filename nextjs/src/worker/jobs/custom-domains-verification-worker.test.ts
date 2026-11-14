// Replays custom-domains-verification-worker.golden.json (scripts/golden/custom-domains-verification-worker.rb):
// CustomDomainsVerificationWorker run by the real app as a Sidekiq job. Node reads the alive domains in the same batches of 1000,
// skips the ones past their attempts and schedules a CustomDomainVerificationWorker for each of the others at the same offset (the
// first straight onto the queue, the rest in the schedule), counting the skipped domains in the position and wrapping every hour.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { customDomainsVerificationWorkerWith } from "./custom-domains-verification-worker.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/custom-domains-verification-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

async function run(c: Case, args: JsonValue[] = []) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(c.statements);
  const handler = customDomainsVerificationWorkerWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("CustomDomainsVerificationWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  it("refuses an argument", async () => {
    const { error } = await run(golden.cases[0]!, [1]);

    expect(error?.message).toMatch(/wrong number of arguments/u);
  });
});
