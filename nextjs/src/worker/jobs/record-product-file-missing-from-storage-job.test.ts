// Replays record-product-file-missing-from-storage-job.golden.json (scripts/golden/record-product-file-missing-from-storage-job.rb):
// RecordProductFileMissingFromStorageJob run by the real app as a Sidekiq job with the two S3 lookups replaced by recorders. Node reads
// the file with the same statement and leaves alone every file Rails left alone; a file that reached S3 (`s3_calls`) is handed back
// right after the read, before anything is written, and so is an id Rails casts (a float, a word).
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
import { recordProductFileMissingFromStorageJobWith } from "./record-product-file-missing-from-storage-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  s3_calls: string[][];
  s3_base_url: string;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/record-product-file-missing-from-storage-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

// The urls in the golden start with the base url of the app that recorded it.
vi.mock("../../server/infra/storage.ts", () => ({
  storageConfig: () => ({
    s3BaseUrl: (
      JSON.parse(
        readFileSync(
          new URL("./__fixtures__/record-product-file-missing-from-storage-job.golden.json", import.meta.url),
          "utf8",
        ),
      ) as { cases: { s3_base_url: string }[] }
    ).cases[0]!.s3_base_url,
  }),
}));

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a file id given as a float", "a file id given as a word"]);

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
  const handler = recordProductFileMissingFromStorageJobWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RecordProductFileMissingFromStorageJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.s3_calls.length === 0)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.s3_calls.length > 0)) {
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
});
