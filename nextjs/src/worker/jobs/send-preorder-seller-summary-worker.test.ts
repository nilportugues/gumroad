// Replays send-preorder-seller-summary-worker.golden.json (scripts/golden/send-preorder-seller-summary-worker.rb):
// SendPreorderSellerSummaryWorker run by the real app as a Sidekiq job. Node sends the statements Rails sent (the link, then the
// preorders still waiting on a charge), pushes the same MailDeliveryJob for ContactingCreatorMailer#preorder_summary or schedules the
// same retry 20 minutes out, and notifies and raises the same timeout error.
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
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { sendPreorderSellerSummaryWorkerWith } from "./send-preorder-seller-summary-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  errors: [string[], Record<string, string>][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/send-preorder-seller-summary-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

async function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const notified: string[] = [];
  const handler = sendPreorderSellerSummaryWorkerWith({ notify: (message) => notified.push(message) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error, notified, recording };
}

describe("SendPreorderSellerSummaryWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, error, notified, recording } = await run(c.args, c.statements);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
      expect(notified).toEqual(c.errors.map(([messages]) => messages[0]));
    });
  }

  for (const [name, args] of [
    ["a float link id", [1.5]],
    ["a null link id", [null]],
    ["attempts given as a string", [1, "2"]],
    ["a float attempts count", [1, 1.5]],
  ] as [string, JsonValue[]][]) {
    it(`hands ${name} back before any statement`, async () => {
      const { sql, error, recording } = await run(args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
