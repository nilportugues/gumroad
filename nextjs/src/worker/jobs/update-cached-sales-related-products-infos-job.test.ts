// Replays update-cached-sales-related-products-infos-job.golden.json (scripts/golden/update-cached-sales-related-products-infos-job.rb):
// UpdateCachedSalesRelatedProductsInfosJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the product,
// the related counts, the cache row, then the create and the validated update) and fails with the same error.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
import { updateCachedSalesRelatedProductsInfosJobWith } from "./update-cached-sales-related-products-infos-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/update-cached-sales-related-products-infos-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };
const handler = updateCachedSalesRelatedProductsInfosJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Rails writes the counts in sales-count order; a JS object lists integer-like keys ascending, and MySQL stores the JSON
// normalized either way, so compare the counts literal by content.
const COUNTS_LITERAL = /'(\{(?:\\"\d+\\":-?\d+,?)*\})'/gu;
function byContent(statement: string): string {
  return statement.replace(COUNTS_LITERAL, (_, text: string) => {
    const parsed = JSON.parse(text.replaceAll('\\"', '"')) as Record<string, number>;
    return `'${JSON.stringify(
      Object.entries(parsed)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, v]) => [k, v]),
    )}'`;
  });
}

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

describe("UpdateCachedSalesRelatedProductsInfosJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log.map(byContent)).toEqual(sql.expected.map(byContent));
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const args of [["abc"], [null], [1.5], [" 1 "], []] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const { runtime: jobs } = runtime();
      await expect(asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now)).rejects.toBeInstanceOf(Error);
      expect(sql.log).toEqual([]);
    });
  }
});
