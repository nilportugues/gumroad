// Replays subtitle-file-size-worker.golden.json (scripts/golden/subtitle-file-size-worker.rb): SubtitleFileSizeWorker run by the real
// app as a Sidekiq job, the S3 HEAD answered by WebMock. Node asks for the same bucket and key, sends the statements Rails sent
// (the find, then the save's transaction with the product file load, the size update and its PaperTrail version) and fails with the
// same Ruby error. A storage answer other than found, not found and forbidden, and a size past the integer column, hand back
// before the save.
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
import { subtitleFileSizeWorkerWith } from "./subtitle-file-size-worker.ts";

type Answer = { status?: number; headers?: Record<string, string> };
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  http: { method: string; url: string }[];
  http_responses: Answer[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/subtitle-file-size-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; s3_base_url: string; cases: Case[] };

const BUCKET = "gumroad-specs";
// Rails fails inside the save on these, after its transaction began; Node hands back before it.
const HANDED_BACK = new Set(["a size past an integer column", "a storage error"]);

const keyOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(`/${BUCKET}/`.length));

function fakeStorage(answers: Answer[]) {
  const requests: { bucket: string; key: string }[] = [];
  const queue = [...answers];
  return {
    requests,
    s3: {
      contentLength(bucket: string, key: string) {
        requests.push({ bucket, key });
        const answer = queue.shift() ?? {};
        const status = answer.status ?? 200;
        if (status !== 200)
          return Promise.reject(Object.assign(new Error("S3 error"), { $metadata: { httpStatusCode: status } }));
        const length = answer.headers?.["Content-Length"];
        return Promise.resolve(length === undefined ? undefined : Number(length));
      },
      read: () => Promise.reject(new Error("not used")),
    },
  };
}

async function run(c: Case, args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const storage = fakeStorage(c.http_responses);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = subtitleFileSizeWorkerWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    { s3: storage.s3, baseUrl: () => golden.s3_base_url, bucket: () => BUCKET },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, storage, error, recording };
}

describe("SubtitleFileSizeWorker", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, storage, error, recording } = await run(c, c.args, c.statements);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(storage.requests).toEqual(c.http.map((r) => ({ bucket: BUCKET, key: keyOf(r.url) })));
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before the save`, async () => {
      // Only the find reached the database before Node gave up.
      const { sql, storage, error } = await run(c, c.args, c.statements.slice(0, 1));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(storage.requests.length).toBeGreaterThan(0);
    });
  }

  for (const [name, id] of [
    ["a Float id", new RubyFloat(1)],
    ["a string that is not digits", "1abc"],
  ] as const) {
    it(`hands ${name} back before any statement`, async () => {
      const { sql, storage, error } = await run(golden.cases[0]!, [id], []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(storage.requests).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { sql, error } = await run(golden.cases[0]!, [], []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
