// Replays refresh-custom-domain-routability-worker.golden.json (scripts/golden/refresh-custom-domain-routability-worker.rb):
// RefreshCustomDomainRoutabilityWorker run by the real app as a Sidekiq job with the routability service replaced by a recorder. Node
// reads the domain with the same statement and leaves alone every domain Rails left alone; a domain that reached the service is
// handed back right after the read, and so is an id Rails casts (a float, a word).
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
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { refreshCustomDomainRoutabilityWorkerWith } from "./refresh-custom-domain-routability-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  processed: number[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/refresh-custom-domain-routability-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number | RubyFloat; cases: Case[] };
// A whole-second `now` is parsed as a RubyFloat.
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a domain id given as a float", "a domain id given as a word"]);

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
  const handler = refreshCustomDomainRoutabilityWorkerWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RefreshCustomDomainRoutabilityWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.processed.length === 0)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => c.processed.length > 0 && !CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back after reading it`, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

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
});
