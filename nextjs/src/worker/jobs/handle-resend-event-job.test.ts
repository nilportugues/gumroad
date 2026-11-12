// Replays handle-resend-event-job.golden.json (scripts/golden/handle-resend-event-job.rb): HandleResendEventJob run by the real app
// as a Sidekiq job. Node drops the events Rails drops, and hands back the ones Rails acts on or fails on, before any statement. A
// payload whose date or workflow ids Node cannot judge exactly is handed back even where Rails drops it (CONSERVATIVE).
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { handleResendEventJob } from "./handle-resend-event-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/handle-resend-event-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Rails drops these; the parser behind them (Ruby's Time.zone.parse, JSON.parse) is not reproduced for every input.
const CONSERVATIVE = new Set(["an untracked type with a created_at that does not parse"]);

beforeEach(() => vi.stubEnv("MAILER_HEADERS_ENCRYPTION_KEY_V1", "test_encryption_key"));
afterEach(() => vi.unstubAllEnvs());

function runtime() {
  const recording = recordingSidekiqRedis();
  return createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

describe("HandleResendEventJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handleResendEventJob(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      const handedBack = c.hands_back || c.error !== null || CONSERVATIVE.has(c.name);
      expect((error as Error | null)?.name ?? null).toBe(handedBack ? "HandBackToRuby" : null);
      expect(sql.log).toEqual([]);
      expect(sql.expected).toEqual([]);
    });
  }

  for (const args of [[], [null], [[]], ["x"], [1]] as JsonValue[][]) {
    it(`rejects ${JSON.stringify(args)} before any statement`, async () => {
      const outcome = asSidekiqJob(() => handleResendEventJob(args, contextFor(runtime())), golden.now);
      if (args.length === 0) await expect(outcome).rejects.toThrow("wrong number of arguments");
      else await expect(outcome).rejects.toMatchObject({ name: "HandBackToRuby" });
    });
  }
});
