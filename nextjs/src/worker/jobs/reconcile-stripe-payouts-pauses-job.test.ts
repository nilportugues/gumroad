// Replays reconcile-stripe-payouts-pauses-job.golden.json (scripts/golden/reconcile-stripe-payouts-pauses-job.rb):
// ReconcileStripePayoutsPausesJob run by the real app as a Sidekiq job. Node sends the same statements, checks replica lag once per
// batch and leaves the same Sidekiq state. Each enqueue takes a unique-jobs lock, so the cases that enqueue need a scratch Redis:
// JOBS_REDIS_URL=redis://127.0.0.1:6379/12 npm test.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { reconcileStripePayoutsPausesJobWith } from "./reconcile-stripe-payouts-pauses-job.ts";

type Case = {
  name: string;
  args: unknown[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  replica_lag_watches: number;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/reconcile-stripe-payouts-pauses-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

const takesLocks = (c: Case) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));

describe("ReconcileStripePayoutsPausesJob", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c) && !url)(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c)) {
        await realRedis!.flushdb();
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = () => Promise.resolve(recording.snapshot());
      }
      const runtime = createJobsRuntime({
        sidekiqRedis,
        bullmqRedis: sidekiqRedis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let watches = 0;
      const handler = reconcileStripePayoutsPausesJobWith({
        watchReplicaLag: () => {
          watches += 1;
          return Promise.resolve();
        },
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args as never[], contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_lag_watches);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(await snapshot()).toEqual(c.redis);
    });
  }
});
