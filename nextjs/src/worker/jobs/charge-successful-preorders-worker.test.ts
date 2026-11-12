// Replays charge-successful-preorders-worker.golden.json (scripts/golden/charge-successful-preorders-worker.rb):
// ChargeSuccessfulPreordersWorker run by the real app as a Sidekiq job. Node sends the statements Rails sent, pushes a
// ChargePreorderWorker per authorized preorder and the delayed seller summary, or fails with Ruby's NoMethodError for a missing link.
// An id Rails casts (a Float, a word) hands back before any statement.
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
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { chargeSuccessfulPreordersWorkerWith } from "./charge-successful-preorders-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  at: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/charge-successful-preorders-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a preorder link id given as a float", "a preorder link id given as a word"]);

async function run(args: JsonValue[], at: number, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => at,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => chargeSuccessfulPreordersWorkerWith()(args, contextFor(runtime)), at);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("ChargeSuccessfulPreordersWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name))) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, Number(c.at), c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, recording, error } = await run(c.args, Number(c.at), []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { sql, error } = await run([], Number(golden.cases[0]!.at), []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
