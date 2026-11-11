// Replays delete-product-rich-content-worker.golden.json (scripts/golden/delete-product-rich-content-worker.rb):
// DeleteProductRichContentWorker run by the real app as a Sidekiq job. Node sends the statements Rails sent (the existence checks,
// each page's validated soft delete with its PaperTrail version, the variants query) and fails with the same error.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { descriptionMatchesSchema } from "../../server/models/rich-content-writes.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { deleteProductRichContentWorkerWith } from "./delete-product-rich-content-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/delete-product-rich-content-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = deleteProductRichContentWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

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

describe("DeleteProductRichContentWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements, { parseJsonOf: ["rich_contents"] });
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands back a description the json-schema gem would take for a URI to open", () => {
    expect(() => descriptionMatchesSchema("/etc/hosts")).toThrow(/not ported/u);
    expect(descriptionMatchesSchema("abc")).toBe(false);
  });

  for (const args of [["abc"], [null], [1.5], [1, "abc"], [1, true], [1, 2.5], [1, []]] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back`, async () => {
      const sql = sqlReplay([]);
      const { runtime: jobs } = runtime();
      await expect(asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now)).rejects.toBeInstanceOf(Error);
      // The product is read before the variant argument is judged.
      expect(sql.log.length).toBeLessThanOrEqual(1);
    });
  }
});
