// Replays delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb): DeleteProductFilesWorker run by the real
// app as a Sidekiq job, Elasticsearch answered with the case's count. Node sends the statements and the one purchases search Rails sent
// and fails with the same error; a deleted product with no sales and a file row is handed back before ProductFile#delete!, with
// nothing written. An id Rails casts (a float, a word) is handed back before any statement.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setEsSender, type EsRequest } from "../../server/search/transport.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { deleteProductFilesWorkerWith } from "./delete-product-files-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  es: { method: string; path: string; query: string | null; body: string }[];
  es_body: JsonValue;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/delete-product-files-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = deleteProductFilesWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

const CAST_IDS = new Set(["a product id given as a float", "a product id given as a word"]);

let restoreEs: () => void = () => {};
let sent: EsRequest[] = [];
let answer: JsonValue = {};
beforeEach(() => {
  sent = [];
  restoreEs = setEsSender((request) => {
    sent.push(request);
    return Promise.resolve({ status: 200, body: answer });
  });
});
afterEach(() => restoreEs());

async function run(c: Case, statements: Statement[]) {
  answer = c.es_body;
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("DeleteProductFilesWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name))) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c, c.statements);

      if (c.hands_back) expect(error?.name).toBe("HandBackToRuby");
      else expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(sql.log.some((statement) => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
      expect(
        sent.map((r) => ({
          method: r.method,
          path: r.path,
          query: new URLSearchParams(r.query ?? {}).toString() || null,
          body: r.body ?? null,
        })),
      ).toEqual(c.es.map(({ method, path, query, body }) => ({ method, path, query, body })));
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, error } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(sent).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { error } = await run(golden.cases[0]!, []);

    expect(error).not.toBeNull();
  });
});
