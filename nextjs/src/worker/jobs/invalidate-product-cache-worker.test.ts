// Replays invalidate-product-cache-worker.golden.json (scripts/golden/invalidate-product-cache-worker.rb): InvalidateProductCacheWorker
// run by the real app as a Sidekiq job. Node deletes the same cache key and expires each fresh cached value with the statements
// Rails sent, and fails the same way for a product that does not exist. An id that is not an Integer or its digits hands back.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { invalidateProductCacheWorkerWith } from "./invalidate-product-cache-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  cache: [string, string][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/invalidate-product-cache-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = invalidateProductCacheWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Rails raises (RecordNotFound or a type error) for these; Node has no port of the id cast and hands the job back.
const HAND_BACK = new Set([
  "a nil id",
  "an id that is not a number",
  "an id past a bigint",
  "an id past 2**53",
  "an id given as a float",
]);

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

afterEach(resetLinkCollaborators);

describe("InvalidateProductCacheWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      const cache: [string, string][] = [];
      setLinkCollaborators({ cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])) });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
        expect(cache).toEqual([]);
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
        expect(cache).toEqual(c.cache);
      }
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    await expect(asSidekiqJob(() => handler([], contextFor(jobs)), golden.now)).rejects.toBeInstanceOf(Error);
    expect(sql.log).toEqual([]);
  });
});
