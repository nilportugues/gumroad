// Replays regenerate-sales-related-products-infos-job.golden.json (scripts/golden/regenerate-sales-related-products-infos-job.rb):
// RegenerateSalesRelatedProductsInfosJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the buyers'
// emails, the customer counts, the batched delete and the INSERT IGNORE slices) and fails with the same error. An argument Ruby casts
// or rejects in ways the port does not reproduce is handed back before any statement.
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
import { regenerateSalesRelatedProductsInfosJobWith } from "./regenerate-sales-related-products-infos-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/regenerate-sales-related-products-infos-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };
const handler = regenerateSalesRelatedProductsInfosJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const result = asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now).then(
    () => null,
    (error: unknown) => error as Error,
  );
  return { sql, recording, result };
}

// Cases whose arguments Ruby casts (a string id or limit) or runs with a float or null: Node gives them back.
const HANDED_BACK = new Set([
  "a negative email limit",
  "a product id given as a string",
  "a product id given as a float",
  "an email limit given as null",
  "an email limit given as a string",
]);

describe("RegenerateSalesRelatedProductsInfosJob", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, recording, result } = run(c.args, c.statements);
      const error = await result;

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const args = c.args.map((arg) =>
        typeof arg === "number" && c.name.includes("float") ? new RubyFloat(arg) : arg,
      );
      const { sql, recording, result } = run(args, []);

      expect((await result)?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
