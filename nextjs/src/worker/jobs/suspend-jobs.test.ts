// Replays suspend-jobs.golden.json (scripts/golden/suspend-jobs.rb): each job run by the real app
// against MySQL. The Node handler must send the statements Rails sent, given the same answers.
// Every suspension takes unique-jobs locks, so those cases need JOBS_REDIS_URL (a scratch
// database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";
import { setSellerProfileCacheForTesting } from "../../server/models/seller-profile.ts";
import { resetRiskCollaborators, setRiskCollaborators } from "../../server/models/user-risk.ts";
import { resetUserCollaborators, setUserCollaborators } from "../../server/models/user.ts";
import { esRecorder } from "../../server/search/__fixtures__/job-harness.ts";
import { contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { suspendAccountsWithPaymentAddressWorkerWith, suspendUsersWorkerWith } from "./suspend-jobs.ts";

type SuspendJobCase = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  es?: { method: string; path: string; query: string | null; body: string | null }[];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/suspend-jobs.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: SuspendJobCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));

const HANDLERS = {
  SuspendAccountsWithPaymentAddressWorker: suspendAccountsWithPaymentAddressWorkerWith({ now }),
  SuspendUsersWorker: suspendUsersWorkerWith({ now }),
} as const;

const takesLocks = (redis: RedisSnapshot) => Object.keys(redis).some((key) => key.startsWith("uniquejobs"));
const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;

const MOBILE_UID_ENV = "MOBILE_API_OAUTH_APPLICATION_UID";
let previousMobileUid: string | undefined;

beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});
beforeEach(() => {
  previousMobileUid = process.env[MOBILE_UID_ENV];
  process.env[MOBILE_UID_ENV] = "test-mobile-api-oauth-app-uid";
});
afterEach(() => {
  if (previousMobileUid === undefined) delete process.env[MOBILE_UID_ENV];
  else process.env[MOBILE_UID_ENV] = previousMobileUid;
  resetUserCollaborators();
  resetRiskCollaborators();
  resetLinkCollaborators();
});

async function run(job: keyof typeof HANDLERS, args: JsonValue[], locks: boolean) {
  let sidekiqRedis: Redis;
  let snapshot: () => Promise<RedisSnapshot>;
  if (locks) {
    await realRedis!.flushdb();
    sidekiqRedis = realRedis!;
    snapshot = () => snapshotRedis(realRedis!);
  } else {
    const recording = recordingSidekiqRedis();
    sidekiqRedis = recording.redis;
    snapshot = async () => recording.snapshot();
  }
  const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
  const cache: [string, string][] = [];
  setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
  setUserCollaborators({ now });
  setRiskCollaborators({
    sadd: (key, member) => sidekiqRedis.pipeline().sadd(key, member).exec(),
    srem: (key, member) => sidekiqRedis.pipeline().srem(key, member).exec(),
  });
  // No seller here has a product, so nothing reads a Flipper gate or $redis.
  setLinkCollaborators({
    isFeatureEnabled: async () => false,
    redis: () => {
      throw new Error("unexpected $redis read");
    },
    cacheDelete: async (name) => void cache.push(["cache_delete", name]),
  });
  const es = esRecorder();
  let error: unknown = null;
  try {
    await HANDLERS[job](args, contextFor(runtime));
  } catch (e) {
    error = e;
  } finally {
    es.restore();
  }
  return { error, cache, es: es.requests, redis: await snapshot() };
}

describe("suspend jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c.redis) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      const result = await run(c.job as keyof typeof HANDLERS, c.args, takesLocks(c.redis));
      expect(sql.log).toEqual(sql.expected);
      expect(result.error === null ? null : (result.error as Error).message).toEqual(c.error?.message ?? null);
      expect(result.cache).toEqual(c.cache);
      expect(result.es).toEqual(c.es ?? []);
      expect(result.redis).toEqual(c.redis);
    });
  }

  it("SuspendUsersWorker refuses a scheduled payout before sending a statement", async () => {
    const sql = sqlReplay([]);
    const { error } = await run("SuspendUsersWorker", [3, ["5"], "spam", null, { action: "payout" }], false);
    expect((error as Error).name).toBe("NotPortedError");
    expect(sql.log).toEqual([]);
  });

  it("SuspendUsersWorker refuses a delay it cannot validate like Rails", async () => {
    const sql = sqlReplay([]);
    const { error } = await run("SuspendUsersWorker", [3, ["5"], "spam", null, { action: "hold", delay_days: "1.5" }], false);
    expect((error as Error).name).toBe("NotPortedError");
    expect(sql.log).toEqual([]);
  });
});
