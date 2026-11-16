// Replays record-product-file-missing-from-storage-job.golden.json (scripts/golden/record-product-file-missing-from-storage-job.rb):
// RecordProductFileMissingFromStorageJob run by the real app as a Sidekiq job with the two S3 lookups replaced by recorders. Node reads
// the file with the same statement and leaves alone every file Rails left alone. A file with a printable-ASCII key (which has no Unicode
// variants, so Rails makes no variant request) gets one HEAD of its own: answered found it is left alone, answered 404 it is marked with
// the UPDATE Rails sent. A key with other characters, or an empty one, is handed back right after the read, and so is an id Rails casts
// (a float, a word) before any statement.
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
  at: number | RubyFloat;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/record-product-file-missing-from-storage-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;
const BUCKET = "gumroad-specs";

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
    s3Bucket: "gumroad-specs",
  }),
}));

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a file id given as a float", "a file id given as a word"]);
// Keys Node does not look up: accented (Unicode variants) and empty.
const KEYS_HANDED_BACK = new Set([
  "a file with an accented key missing from storage",
  "a file with an accented key present in storage",
  "a file with an accented key found under another unicode form",
  "a file whose url is the storage prefix alone",
]);
// Recorded with a replaced variant lookup that finds a variant for an ASCII key, which Rails never does: Rails stopped before the
// object lookup there, and Node, which has no variants to find, makes its HEAD and finds the object.
const REPLACED_VARIANT = "a file found under another unicode form";

const notFound = Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
const forbidden = Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } });

async function run(
  args: JsonValue[],
  statements: Statement[],
  head: (key: string) => Promise<number | undefined>,
  at: number = NOW,
) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => at,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  const heads: { bucket: string; key: string }[] = [];
  const s3 = {
    contentLength: (bucket: string, key: string) => {
      heads.push({ bucket, key });
      return head(key);
    },
    read: () => Promise.reject(new Error("not used")),
  };
  const handler = recordProductFileMissingFromStorageJobWith({ now: () => new Date(Math.round(at * 1000)) }, { s3 });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), at);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording, heads };
}

const seconds = (at: number | RubyFloat) => (at instanceof RubyFloat ? at.value : at);
const marks = (c: Case) => c.statements.length > 1;
const found = () => Promise.resolve(1);
const missing = () => Promise.reject(notFound);

describe("RecordProductFileMissingFromStorageJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.s3_calls.length === 0)) {
    it(c.name, async () => {
      const { error, sql, recording, heads } = await run(c.args, c.statements, found);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
      expect(heads).toEqual([]);
    });
  }

  for (const c of golden.cases.filter(
    (c) => !CAST_IDS.has(c.name) && !KEYS_HANDED_BACK.has(c.name) && c.s3_calls.length > 0,
  )) {
    it(`${c.name}: looks the object up and ${marks(c) ? "marks it missing" : "leaves it alone"}`, async () => {
      const { error, sql, recording, heads } = await run(
        c.args,
        c.statements,
        marks(c) ? missing : found,
        seconds(c.at),
      );

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
      if (c.name !== REPLACED_VARIANT) {
        expect(heads).toHaveLength(c.s3_calls.filter(([call]) => call === "exists?").length);
        expect(heads[0]).toEqual({ bucket: BUCKET, key: c.s3_calls[0]![1] });
      }
    });
  }

  for (const c of golden.cases.filter((c) => KEYS_HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back after reading it`, async () => {
      const { error, sql, recording, heads } = await run(c.args, c.statements.slice(0, 1), missing);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
      expect(heads).toEqual([]);
    });
  }

  it("hands a file back when the storage answers a HEAD with an error other than not found", async () => {
    const c = golden.cases.find((c) => c.name === "a file missing from storage")!;
    const { error, sql, heads } = await run(c.args, c.statements.slice(0, 1), () => Promise.reject(forbidden));

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(heads).toHaveLength(1);
  });

  it("hands a file back when the storage answers a HEAD with a server error", async () => {
    const c = golden.cases.find((c) => c.name === "a file missing from storage")!;
    const serverError = Object.assign(new Error("InternalError"), { $metadata: { httpStatusCode: 500 } });
    const { error, sql } = await run(c.args, c.statements.slice(0, 1), () => Promise.reject(serverError));

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
  });

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { error, sql, heads } = await run(c.args, [], missing);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(heads).toEqual([]);
    });
  }
});
