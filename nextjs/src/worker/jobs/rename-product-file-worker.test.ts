// Replays rename-product-file-worker.golden.json (scripts/golden/rename-product-file-worker.rb): RenameProductFileWorker run by the
// real app as a Sidekiq job with the storage copy replaced by a recorder. Node reads the file with the same statement, leaves alone
// the files Rails left alone and fails with the Ruby errors Rails raised before the copy. A file that reached the copy, one whose
// owner Rails had to read and one whose url ends in a dot are handed back right after the read, and an id Rails casts (a float, a
// word) before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
import { renameProductFileWorkerWith } from "./rename-product-file-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  transfers: string[][];
  s3_base_url: string;
};
const fixture = new URL("./__fixtures__/rename-product-file-worker.golden.json", import.meta.url);
const golden = parseRubyJson(readFileSync(fixture, "utf8")) as unknown as { cases: Case[] };
const NOW = Date.UTC(2026, 10, 4, 12, 30, 45) / 1000;

// The urls in the golden start with the base url of the app that recorded it.
vi.mock("../../server/infra/storage.ts", () => ({
  storageConfig: () => ({
    s3BaseUrl: (
      JSON.parse(
        readFileSync(new URL("./__fixtures__/rename-product-file-worker.golden.json", import.meta.url), "utf8"),
      ) as { cases: { s3_base_url: string }[] }
    ).cases[0]!.s3_base_url,
  }),
}));

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a file id given as a float", "a file id given as a word"]);
const isHandedBack = (c: Case) =>
  c.transfers.length > 0 || c.error?.class === "ActiveSupport::DelegationError" || c.name.includes("trailing dot");

async function run(args: JsonValue[], statements: Statement[]) {
  const recording = recordingSidekiqRedis();
  const now = NOW;
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => renameProductFileWorkerWith()(args, contextFor(runtime)), now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RenameProductFileWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !isHandedBack(c))) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(error?.name ?? null).toEqual(c.error?.class ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && isHandedBack(c))) {
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
