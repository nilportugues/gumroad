// Replays send-post-blast-emails-slice-job.golden.json (scripts/golden/send-post-blast-emails-slice-job.rb): SendPostBlastEmailsSliceJob
// run by the real app as a Sidekiq job. Node sends the statements Rails sent for the blast and its post and finishes where Rails' first
// guard returns or raises RecordNotFound. A slice that passes the guard (`hands_back` in the golden) and a blast whose post is gone
// (a NoMethodError in Rails) are handed back after the same statements; an id Rails casts (nil, a float, a word) before any statement.
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
import { sendPostBlastEmailsSliceJobWith } from "./send-post-blast-emails-slice-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/send-post-blast-emails-slice-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const CAST_IDS = new Set(["a blast id of nil", "a blast id as a float", "a blast id as a word"]);
const ARITY = "ArgumentError";
const handsBack = (c: Case) => c.hands_back || c.error?.class === "NoMethodError";

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
  const handler = sendPostBlastEmailsSliceJobWith();
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("SendPostBlastEmailsSliceJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !handsBack(c) && c.error?.class !== ARITY)) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && handsBack(c))) {
    it(`hands ${c.name} back`, async () => {
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

  for (const c of golden.cases.filter((c) => c.error?.class === ARITY)) {
    it(`rejects ${c.name}, as perform takes five`, async () => {
      const { sql, error } = await run(c.args, []);

      expect(error).not.toBeNull();
      expect(sql.log).toEqual([]);
    });
  }
});
