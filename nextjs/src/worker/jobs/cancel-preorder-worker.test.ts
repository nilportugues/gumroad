// Replays cancel-preorder-worker.golden.json (scripts/golden/cancel-preorder-worker.rb): CancelPreorderWorker run by the real app as a
// Sidekiq job. Node reads the preorder with the same statement, leaves every preorder that is not authorized alone and fails with
// Ruby's NoMethodError for a missing one. An authorized preorder (Rails went on to cancel it) hands back right after the read, and
// an id Rails casts (a float, a word) before any statement.
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
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { cancelPreorderWorkerWith } from "./cancel-preorder-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/cancel-preorder-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };
const NOW = Date.UTC(2026, 10, 4, 12, 30, 45) / 1000;

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a preorder id given as a float", "a preorder id given as a word"]);
// Rails went on to cancel the preorder.
const CANCELS = (c: Case) => c.statements.length > 1;

async function run(args: JsonValue[], statements: Statement[]) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => cancelPreorderWorkerWith()(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("CancelPreorderWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !CANCELS(c))) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && CANCELS(c))) {
    it(`hands ${c.name} back after reading it`, async () => {
      const { error, sql, recording } = await run(c.args, c.statements.slice(0, 1));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { error, sql } = await run(c.args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { sql, error } = await run([], []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
