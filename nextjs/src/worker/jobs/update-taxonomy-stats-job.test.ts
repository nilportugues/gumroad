// Replays update-taxonomy-stats-job.golden.json (scripts/golden/update-taxonomy-stats-job.rb): UpdateTaxonomyStatsJob run by the real
// app as a Sidekiq job. Node sends the statements Rails sent (the roots, each subtree, the stat's find-or-create and update), the same
// two Elasticsearch searches per root and fails with the same Ruby error on an answer without the totals it reads. An answer whose
// cardinality is not a number the column takes is handed back before the stat is saved.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { updateTaxonomyStatsJobWith } from "./update-taxonomy-stats-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/update-taxonomy-stats-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = updateTaxonomyStatsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Rails stores what these answers hold (null, a NULL write into a NOT NULL column that the scratch MySQL let through);
// Node does not reproduce that write.
const HANDED_BACK = new Set(["cardinalities that are null"]);

async function run(c: Case, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
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
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, recording };
}

describe("UpdateTaxonomyStatsJob", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, es, error, recording } = await run(c, c.statements);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before the stat is saved`, async () => {
      // Up to the last statement before the update's BEGIN: roots, subtree, stat, insert and its transaction.
      const lastBegin = c.statements.map((s) => s.sql).lastIndexOf("BEGIN");
      const { sql, es, error } = await run(c, c.statements.slice(0, lastBegin));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      // Handed back as soon as the aggregation answer is read, before the recent sales search.
      expect(es.requests).toEqual(c.es.slice(0, 1));
    });
  }
});
