// Replays flush-delivered-email-infos-job.golden.json (scripts/golden/flush-delivered-email-infos-job.rb):
// FlushDeliveredEmailInfosJob run by the real app as a Sidekiq job. Node must send the same UPDATEs and leave the
// same Redis keys behind (buffer, inflight list, lock). Redis is a scratch database named by JOBS_REDIS_URL, so the
// golden cases are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { flushDeliveredEmailInfosJobWith } from "./flush-delivered-email-infos-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  chunk: number;
  max_chunks: number;
  lose_lock_at: number | null;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/flush-delivered-email-infos-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

const BUFFER = "email_info:delivered_buffer";
const INFLIGHT = "email_info:delivered_inflight";
const LOCK = "email_info:delivered_flush_lock";
const entry = (installmentId: number, purchaseId: number, epoch: number) =>
  JSON.stringify({ i: installmentId, p: purchaseId, t: epoch });

// Puts back what the generator's setup wrote (`redis_before`): the buffer and inflight lists and a held lock.
async function restore(before: RedisSnapshot | undefined) {
  await redis!.flushdb();
  for (const [key, value] of Object.entries(before ?? {})) {
    if (value.type === "list") await redis!.rpush(key, ...(value.value as string[]));
    else if (value.type === "string") await redis!.set(key, String(value.value), "EX", 600);
  }
}

function runtime() {
  return createJobsRuntime({
    sidekiqRedis: redis!,
    bullmqRedis: redis!,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};

function handler(options: { chunk?: number; maxChunks?: number; loseLockAt?: number | null } = {}) {
  let renewals = 0;
  return flushDeliveredEmailInfosJobWith(
    { now, uuid: sequentialUuid() },
    {
      redis: () => redis!,
      chunk: options.chunk,
      maxChunks: options.maxChunks,
      // Mirrors the generator, which makes every renewal from the nth on fail.
      renewLock: async (client, token) => {
        renewals += 1;
        if (options.loseLockAt && renewals >= options.loseLockAt) return false;
        return Number(await client.eval(RENEW, 1, LOCK, token, "600")) === 1;
      },
    },
  );
}
const RENEW = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) end return 0`;

describe.skipIf(!url)("FlushDeliveredEmailInfosJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      await restore(c.redis_before);
      let error: unknown = null;
      try {
        await asSidekiqJob(
          () =>
            handler({ chunk: c.chunk, maxChunks: c.max_chunks, loseLockAt: c.lose_lock_at })([], contextFor(runtime())),
          golden.now,
        );
      } catch (e) {
        error = e;
      }

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(await snapshotRedis(redis!)).toEqual(c.redis);
    });
  }
});

describe.skipIf(!url)("FlushDeliveredEmailInfosJob without a golden", () => {
  it("hands the job back when an entry is not three integers, leaving the chunk in the inflight list and the lock released", async () => {
    const sql = sqlReplay([]);
    await redis!.flushdb();
    await redis!.rpush(BUFFER, entry(1, 1, 1_793_700_000), JSON.stringify({ i: "1", p: 2, t: 1_793_700_000 }));
    await expect(asSidekiqJob(() => handler()([], contextFor(runtime())), golden.now)).rejects.toBeInstanceOf(
      HandBackToRuby,
    );
    expect(sql.log).toEqual([]);
    expect(await redis!.llen(BUFFER)).toBe(0);
    expect(await redis!.llen(INFLIGHT)).toBe(2);
    expect(await redis!.exists(LOCK)).toBe(0);
  });

  it("hands the job back when an entry is not JSON", async () => {
    sqlReplay([]);
    await redis!.flushdb();
    await redis!.rpush(BUFFER, "not json");
    await expect(asSidekiqJob(() => handler()([], contextFor(runtime())), golden.now)).rejects.toBeInstanceOf(
      HandBackToRuby,
    );
  });

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    await redis!.flushdb();
    await expect(asSidekiqJob(() => handler()([1], contextFor(runtime())), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
