// Replays sync-guardian-to-stripe-job.golden.json (scripts/golden/sync-guardian-to-stripe-job.rb): SyncGuardianToStripeJob run by the
// real app as a Sidekiq job. Node sends the statements Rails sent for a seller paid through their own Connect account or with no
// Gumroad-managed account, and hands back, after the same statements, a seller whose guardian goes to Stripe. The feature checks read
// Flipper, so this runs against a scratch Redis seeded with the case's Flipper documents: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetFlipperStateForTesting } from "../../server/infra/flipper.ts";
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
import { syncGuardianToStripeJobWith } from "./sync-guardian-to-stripe-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis_before: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/sync-guardian-to-stripe-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Rails finds nothing for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
// The Flipper reads of `Feature.active?` go to the main Redis.
beforeAll(() => {
  if (url) process.env.REDIS_HOST = url.replace("redis://", "");
});
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

async function seed(before: RedisSnapshot) {
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "hash") await redis.hset(key, entry.value as Record<string, string>);
    else if (entry.type === "set") await redis.sadd(key, ...(entry.value as string[]));
    else if (entry.type === "string") await redis.set(key, entry.value as string);
    else throw new Error(`cannot seed a ${entry.type}`);
  }
}

describe.skipIf(!url)("SyncGuardianToStripeJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      await redis.flushdb();
      await seed(c.redis_before);
      resetFlipperStateForTesting();
      const sql = sqlReplay(c.statements);
      const pushes = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: pushes.redis,
        bullmqRedis: pushes.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: Error | null = null;
      try {
        await asSidekiqJob(() => syncGuardianToStripeJobWith()(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e as Error;
      }

      expect(pushes.snapshot()).toEqual({});
      if (castByRails(c.args[0])) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
      } else if (c.hands_back) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected);
      } else {
        expect(error?.message ?? null).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
      }
    });
  }
});
