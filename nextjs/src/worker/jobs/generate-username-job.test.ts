// Replays generate-username-job.golden.json (scripts/golden/generate-username-job.rb): GenerateUsernameJob run by the real app as a
// Sidekiq job with OpenAI answered by WebMock. Node sends the user read and finishes, or fails with RecordNotFound, as Rails did when no
// completion is needed; a user who needs one (`http` holds the request) is handed back right after the read, before anything is sent or
// written. An id Rails casts (nil, a float, a word) hands back before any statement.
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
import { generateUsernameJobWith } from "./generate-username-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  http: unknown[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/generate-username-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

const CAST_IDS = new Set([
  "a user id of nil",
  "a user id given as a float and a username",
  "a user id given as a word",
]);

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
  const handler = generateUsernameJobWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("GenerateUsernameJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.http.length === 0)) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.http.length > 0)) {
    it(`hands ${c.name} back after reading the user`, async () => {
      const { sql, recording, error } = await run(c.args, c.statements.slice(0, 1));

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
