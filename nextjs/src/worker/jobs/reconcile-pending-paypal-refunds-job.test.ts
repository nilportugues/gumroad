// Replays reconcile-pending-paypal-refunds-job.golden.json (scripts/golden/reconcile-pending-paypal-refunds-job.rb):
// ReconcilePendingPaypalRefundsJob run by the real app as a Sidekiq job. Node sends the one statement Rails sent; a sweep that
// finds a refund is handed back to Rails (the PayPal status call is not ported), so the statements after the first and the
// outbound calls recorded under "http" are not compared.
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
import { reconcilePendingPaypalRefundsJobWith } from "./reconcile-pending-paypal-refunds-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  http?: unknown[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/reconcile-pending-paypal-refunds-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const now = () => new Date(Math.round(golden.now * 1000));

describe("ReconcilePendingPaypalRefundsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
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
        await asSidekiqJob(
          () => reconcilePendingPaypalRefundsJobWith({ now })(c.args, contextFor(runtime)),
          golden.now,
        );
      } catch (e) {
        error = e as Error;
      }

      expect(sql.log).toEqual(sql.expected.slice(0, 1));
      expect(recording.snapshot()).toEqual({});
      // The sweep found a refund exactly when Ruby went on to ask PayPal about it.
      const reconciles = c.statements.length > 1;
      expect(error?.name ?? null).toBe(reconciles ? "HandBackToRuby" : null);
      expect(c.error).toBeNull();
      expect(c.redis).toEqual({});
    });
  }
});
