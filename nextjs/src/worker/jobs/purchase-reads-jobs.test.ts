// Replays purchase-reads-jobs.golden.json (scripts/golden/purchase-reads-jobs.rb): each job run by the
// real app against MySQL as a Sidekiq job. Node must send the statements Rails sent, given the same
// answers, queue the same Sidekiq payloads and fail with the same errors. The jobs Node hands back
// stop after their first read, which must be the statement Rails started with.
// Cases that push a unique job need JOBS_REDIS_URL (a scratch database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

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
import {
  createMissingPurchaseEventsWorkerWith,
  expireRentalPurchasesWorkerWith,
  findExpiredSubscriptionsToSetAsDeactivatedWorkerWith,
  sendRentalExpiresSoonEmailWorkerWith,
  syncStuckPurchasesJobWith,
  updatePurchaseHealthcheckThresholdJobWith,
} from "./purchase-reads-jobs.ts";
import type { JobHandler } from "./types.ts";

type BulkSummary = { keys: Record<string, { type: string; count: number }>; queue_args: JsonValue[][] };
type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot | BulkSummary;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/purchase-reads-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

// The jobs that give up to Rails on the first row their read finds.
const HANDED_BACK = new Set(["ExpireRentalPurchasesWorker", "SyncStuckPurchasesJob"]);

// $redis.set(key, value, ex:) as the generator's snapshot sees it.
function recordingMainRedis() {
  const written: RedisSnapshot = {};
  const redis = {
    async set(key: string, value: string, mode: string, ttl: number) {
      expect(mode).toBe("EX");
      expect(ttl).toBeGreaterThan(0);
      written[key] = { type: "string", value, expires: true };
      return "OK";
    },
  } as unknown as Redis;
  return { redis, written };
}

const handlers = (main: Redis): Record<string, JobHandler> => ({
  UpdatePurchaseHealthcheckThresholdJob: updatePurchaseHealthcheckThresholdJobWith({ now }, { redis: () => main }),
  FindExpiredSubscriptionsToSetAsDeactivatedWorker: findExpiredSubscriptionsToSetAsDeactivatedWorkerWith({ now }),
  SendRentalExpiresSoonEmailWorker: sendRentalExpiresSoonEmailWorkerWith({ now }),
  ExpireRentalPurchasesWorker: expireRentalPurchasesWorkerWith({ now }),
  SyncStuckPurchasesJob: syncStuckPurchasesJobWith({ now }),
  CreateMissingPurchaseEventsWorker: createMissingPurchaseEventsWorkerWith({ now }),
});

const isSummary = (redis: Case["redis"]): redis is BulkSummary => "queue_args" in redis;
const withoutJobIds = (value: unknown) =>
  JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const takesLocks = (redis: Case["redis"]) =>
  isSummary(redis) || Object.keys(redis).some((key) => key.startsWith("uniquejobs"));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url))
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

describe("purchase and subscription read jobs", () => {
  for (const c of golden.cases) {
    // A hand-back leaves before the case's writes; the golden still lists everything Ruby did.
    const firstRead = c.statements[0];
    const handsBack = HANDED_BACK.has(c.job) && (c.args.length > 0 || (firstRead?.result?.rows?.length ?? 0) > 0);

    it.skipIf(takesLocks(c.redis) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      const main = recordingMainRedis();
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c.redis)) {
        await realRedis!.flushdb();
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = async () => recording.snapshot();
      }
      const runtime = createJobsRuntime({
        sidekiqRedis,
        bullmqRedis: sidekiqRedis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handlers(main.redis)[c.job]!(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      if (handsBack) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        // Only the read that precedes Rails' first write.
        expect(sql.log).toEqual(c.args.length > 0 ? [] : [sql.expected[0]]);
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      const redis = await snapshot();
      if (isSummary(c.redis)) {
        expect(
          Object.fromEntries(
            Object.entries(redis).map(([key, entry]) => [
              key,
              { type: entry.type, count: Array.isArray(entry.value) ? entry.value.length : 1 },
            ]),
          ),
        ).toEqual(c.redis.keys);
        expect(
          (redis["queue:default"]!.value as string[]).map((item) => (JSON.parse(item) as { args: JsonValue[] }).args),
        ).toEqual(c.redis.queue_args);
      } else {
        expect(JSON.parse(withoutJobIds({ ...redis, ...main.written }))).toEqual(JSON.parse(withoutJobIds(c.redis)));
      }
    });
  }
});

// Runs without a scratch Redis: the enqueue's unique lock needs the real thing, so this stops at the
// first lock call. Everything Rails sent before it (the read, the event inserts, the seller lookups
// for the cache day) must already match.
describe("CreateMissingPurchaseEventsWorker without Redis", () => {
  it("creates the missing events with the statements Rails sent before it enqueues the cache regeneration", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "missing events: a purchase without an event")!;
    const sql = sqlReplay(c.statements);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(
        () => handlers(recordingMainRedis().redis).CreateMissingPurchaseEventsWorker!(c.args, contextFor(runtime)),
        golden.now,
      ),
    ).rejects.toThrow("hexists");
    expect(sql.log).toEqual(sql.expected);
  });
});
