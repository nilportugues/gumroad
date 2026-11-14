// Replays process-payment-worker.golden.json (scripts/golden/process-payment-worker.rb): ProcessPaymentWorker run by the real app as a
// Sidekiq job with its payout processors replaced by a recorder. Node reads the payment with the same statement, leaves every payment
// that is not processing alone with the same Ruby error for a missing one, and hands a processing payment of another processor back
// before the processor call, and an id Rails casts (a float, a word) back before any statement. A Stripe payment is paid out in Node.
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
import { processPaymentWorkerWith } from "./process-payment-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  processed: [string | null, number[]][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/process-payment-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a payment id given as a float", "a payment id given as a word"]);

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
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => processPaymentWorkerWith()(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("ProcessPaymentWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && c.processed.length === 0)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(recording.snapshot()).toEqual({});
    });
  }

  // A Stripe payment is paid out in Node: payout-users-service.golden.json replays it against the real processor.
  const isStripe = (c: Case) => c.processed.some(([processor]) => processor === "STRIPE");
  for (const c of golden.cases.filter((c) => c.processed.length > 0 && !CAST_IDS.has(c.name) && !isStripe(c))) {
    it(`hands ${c.name} back after reading it`, async () => {
      const { error, sql, recording } = await run(c.args, c.statements);

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
