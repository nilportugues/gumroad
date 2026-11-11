// Replays record-order-charge-outcome-job.golden.json (scripts/golden/record-order-charge-outcome-job.rb): RecordOrderChargeOutcomeJob
// run by the real app as a Sidekiq job. Node reads the order, the two sibling-state checks and issues the same UPDATE of the
// order's flags. An order id that is not an Integer, its digits or nil is handed back.
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
import { recordOrderChargeOutcomeJobWith } from "./record-order-charge-outcome-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/record-order-charge-outcome-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

async function run(args: JsonValue[], statements: Statement[]) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  const handler = recordOrderChargeOutcomeJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RecordOrderChargeOutcomeJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const [name, id] of [
    ["a float", 1.5],
    ["a word", "abc"],
    ["true", true],
  ] as [string, JsonValue][]) {
    it(`hands an order id given as ${name} back before any statement`, async () => {
      const { error, sql } = await run([id], []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("rejects a call without the order id", async () => {
    const { error, sql } = await run([], []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
