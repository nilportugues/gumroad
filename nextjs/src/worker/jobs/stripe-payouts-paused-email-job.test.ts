// Replays stripe-payouts-paused-email-job.golden.json (scripts/golden/stripe-payouts-paused-email-job.rb): StripePayoutsPausedEmailJob run
// by the real app as a Sidekiq job. Node sends the statements Rails sent (both loads, the seller's lock with the account reload, the
// at-stake reads, and the claim release) and pushes the mail Rails pushed once the lock is released.
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
import { stripePayoutsPausedEmailJobWith } from "./stripe-payouts-paused-email-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stripe-payouts-paused-email-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = stripePayoutsPausedEmailJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// ActiveJob's job_id is a random UUID in production; the generator drew them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

describe("StripePayoutsPausedEmailJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }
});
