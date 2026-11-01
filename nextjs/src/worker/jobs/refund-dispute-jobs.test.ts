// Replays refund-dispute-jobs.golden.json (scripts/golden/refund-dispute-jobs.rb): each job run by the
// real app against MySQL as a Sidekiq job. Node must send the statements Rails sent, given the same
// answers, queue the same Sidekiq payloads, report the same errors to ErrorNotifier and fail with
// the same errors. The jobs Node hands back stop where Rails' first write or charge-processor call
// would be, which the golden marks with a stand-in exception.
// Cases that push a unique job need JOBS_REDIS_URL (a scratch database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  createMissingDisputeEvidenceJobWith,
  dispatchPendingFailedRefundExceptionsJobWith,
  fightDisputesJobWith,
  notifyFailedRefundExceptionJobWith,
  recoverPendingRefundFeeRetentionJobWith,
  refundUnpaidPurchasesWorkerWith,
} from "./refund-dispute-jobs.ts";
import type { JobHandler } from "./types.ts";

type Notification = { message: string; context: JsonValue };
type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  notified: Notification[];
  notify_raises: boolean;
  hands_back: boolean;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/refund-dispute-jobs.golden.json", import.meta.url), "utf8")) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

// Dates as the golden writes a TimeWithZone: microsecond precision, `$time`.
const encode = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z$/u.test(v) ? { $time: v.replace(/Z$/u, "000Z") } : v))) as JsonValue;

function handlers(notifications: Notification[], raises: boolean): Record<string, JobHandler> {
  const notify = (errorOrMessage: unknown, context: Record<string, unknown>) => {
    notifications.push({ message: errorOrMessage instanceof Error ? "<exception>" : String(errorOrMessage), context: encode(context) });
    if (raises) throw new Error("Sentry is down");
  };
  return {
    FightDisputesJob: fightDisputesJobWith({ now }),
    DispatchPendingFailedRefundExceptionsJob: dispatchPendingFailedRefundExceptionsJobWith({ now }, { notify }),
    NotifyFailedRefundExceptionJob: notifyFailedRefundExceptionJobWith({ now }, { notify }),
    RefundUnpaidPurchasesWorker: refundUnpaidPurchasesWorkerWith({ now }),
    RecoverPendingRefundFeeRetentionJob: recoverPendingRefundFeeRetentionJobWith({ now }, { notify }),
    CreateMissingDisputeEvidenceJob: createMissingDisputeEvidenceJobWith({ now }),
  };
}

const takesLocks = (redis: RedisSnapshot) => Object.keys(redis).some((key) => key.startsWith("uniquejobs"));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
const savedKeys = { cipher: process.env.OBFUSCATE_IDS_CIPHER_KEY, numeric: process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY };
beforeAll(() => {
  // The keys the Rails test environment uses (.env.test); only the cipher key matters here.
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (savedKeys.cipher === undefined) delete process.env.OBFUSCATE_IDS_CIPHER_KEY;
  else process.env.OBFUSCATE_IDS_CIPHER_KEY = savedKeys.cipher;
  if (savedKeys.numeric === undefined) delete process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY;
  else process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = savedKeys.numeric;
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

describe("refund and dispute jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c.redis) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
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
      const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const notifications: Notification[] = [];
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handlers(notifications, c.notify_raises)[c.job]!(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(notifications).toEqual(c.notified);
      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(await snapshot()).toEqual(c.redis);
    });
  }
});

describe("arguments Node does not reproduce", () => {
  const runtimeFor = () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
    return { recording, runtime };
  };
  const bad: [string, JsonValue[]][] = [
    ["NotifyFailedRefundExceptionJob", [null]],
    ["NotifyFailedRefundExceptionJob", ["abc"]],
    ["RefundUnpaidPurchasesWorker", [null, 2]],
    ["RefundUnpaidPurchasesWorker", [1, "abc"]],
  ];
  for (const [job, args] of bad) {
    it(`${job} hands ${JSON.stringify(args)} back to Rails before any statement`, async () => {
      const sql = sqlReplay([]);
      const { recording, runtime } = runtimeFor();
      await expect(asSidekiqJob(() => handlers([], false)[job]!(args, contextFor(runtime)), golden.now)).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a payload with the wrong number of arguments as Ruby does", async () => {
    await expect(handlers([], false).RefundUnpaidPurchasesWorker!([1], contextFor(runtimeFor().runtime))).rejects.toThrow("wrong number of arguments (given 1, expected 2)");
  });
});
