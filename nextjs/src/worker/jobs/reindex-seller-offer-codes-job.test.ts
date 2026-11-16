// Replays reindex-seller-offer-codes-job.golden.json (scripts/golden/reindex-seller-offer-codes-job.rb): ReindexSellerOfferCodesJob and
// its recovery job run by the real app as Sidekiq jobs, with the indexing service replaced by a recorder. Node takes the same lock,
// honours the same cooldown, re-queues the same five-second job and leaves the same Redis behind; a run that reached the service
// (`indexed`) releases its lock and is handed back with Redis as it found it. The re-queues carry a unique-jobs lock, so this runs
// against a real Redis like retry-stripe-jp-address-resyncs-job.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/34 npm test.
// It is flushed between cases.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import {
  reindexSellerOfferCodesJobRetriesExhausted,
  reindexSellerOfferCodesJobWith,
  reindexSellerOfferCodesRecoveryJobRetriesExhausted,
  reindexSellerOfferCodesRecoveryJobWith,
} from "./reindex-seller-offer-codes-job.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  hook?: boolean;
  error: { class: string; message: string } | null;
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  indexed: number[][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/reindex-seller-offer-codes-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

async function seed(before: RedisSnapshot) {
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") await redis.set(key, entry.value as string);
    else if (entry.type === "hash") await redis.hset(key, entry.value as Record<string, string>);
    else if (entry.type === "zset")
      for (const [member, score] of entry.value as [string, number][])
        await redis.zadd(key, String(plain(score)), member);
    else throw new Error(`cannot seed a ${entry.type}`);
  }
}

async function run(c: Case, args: JsonValue[] = c.args) {
  await redis.flushdb();
  await seed(c.redis_before ?? {});
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const deps = { now: () => new Date(Math.round(golden.now * 1000)) };
  const handler = (
    c.job === "ReindexSellerOfferCodesJob" ? reindexSellerOfferCodesJobWith : reindexSellerOfferCodesRecoveryJobWith
  )(deps, { redis: () => redis });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, runtime };
}

describe.skipIf(!url)("ReindexSellerOfferCodesJob and ReindexSellerOfferCodesRecoveryJob", () => {
  for (const c of golden.cases.filter(
    (c) => !c.hook && c.indexed.length === 0 && c.name !== "a seller id given as a float",
  )) {
    it(c.name, async () => {
      const { error } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }

  for (const c of golden.cases.filter(
    (c) => !c.hook && (c.indexed.length > 0 || c.name === "a seller id given as a float"),
  )) {
    it(`hands ${c.name} back with its lock released`, async () => {
      const { error } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis_before));
    });
  }

  for (const c of golden.cases.filter((c) => c.hook)) {
    it(c.name, async () => {
      await redis.flushdb();
      const runtime = createJobsRuntime({
        sidekiqRedis: redis,
        bullmqRedis: redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const hook =
        c.job === "ReindexSellerOfferCodesJob"
          ? reindexSellerOfferCodesJobRetriesExhausted
          : reindexSellerOfferCodesRecoveryJobRetriesExhausted;
      await hook({ args: c.args } as unknown as SidekiqItem, new Error("boom"), { runtime });

      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }
});
