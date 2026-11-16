// Replays expiring-credit-card-message-worker.golden.json (scripts/golden/expiring-credit-card-message-worker.rb):
// ExpiringCreditCardMessageWorker run by the real app as a Sidekiq job, on the day each case names. Node sends the statements Rails
// sent (the cards expiring next month, their users, each emailable user's active memberships on the card) and pushes the same
// MailDeliveryJob per membership.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { expiringCreditCardMessageWorkerWith } from "./expiring-credit-card-message-worker.ts";

type Case = {
  name: string;
  at: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/expiring-credit-card-message-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

describe("ExpiringCreditCardMessageWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      // A whole-second clock parses as a RubyFloat, which keeps 1797325200.0 distinct from the Integer.
      const at = c.at instanceof RubyFloat ? c.at.value : c.at;
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => at,
        newJid: sequentialJids(),
      });
      const handler = expiringCreditCardMessageWorkerWith({ now: () => new Date(Math.round(at * 1000)) });
      await asSidekiqJob(() => handler([], contextFor(runtime)), at);

      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }
});
