// Replays update-sales-related-products-infos-job.golden.json (scripts/golden/update-sales-related-products-infos-job.rb):
// UpdateSalesRelatedProductsInfosJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the purchase, the
// buyer's other products, the READ COMMITTED upserts and their deadlock retries), sleeps the same backoffs, and schedules the same
// UpdateCachedSalesRelatedProductsInfosJob items. The feature flag and the delay key come from the case's `redis_before`. The scheduled
// jobs carry a unique-jobs lock, so this runs against a real Redis like backfill-price-checker-index-fields-job.test.ts:
// JOBS_REDIS_URL=redis://127.0.0.1:6379/33 npm test. It is flushed between cases.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { updateSalesRelatedProductsInfosJobWith } from "./update-sales-related-products-infos-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  rands_used: [number[], number][];
  sleeps: number[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/update-sales-related-products-infos-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const FEATURE = "update_sales_related_products_infos";
const DELAY_KEY = "update_cached_srpis_job_delay_hours";
// A float id is cast by Rails' find; Node gives it back.
const HANDED_BACK = new Set(["a purchase id given as a float"]);

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

async function run(c: Case, args: JsonValue[], statements: Statement[]) {
  await redis.flushdb();
  const sql = sqlReplay(statements);
  const recording = { snapshot: () => snapshotRedis(redis) };
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const draws = c.rands_used.filter(([callArgs]) => callArgs.length > 0).map(([, value]) => value);
  const jitter = c.rands_used.filter(([callArgs]) => callArgs.length === 0).map(([, value]) => value);
  const sleeps: number[] = [];
  const bounds: number[] = [];
  const handler = updateSalesRelatedProductsInfosJobWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    {
      featureActive: (name) =>
        Promise.resolve(
          evaluateFeature(name, parseGateValues((c.redis_before[name]?.value ?? {}) as Record<string, string>), null),
        ),
      redis: () =>
        ({
          get: (key: string) => Promise.resolve((c.redis_before[key]?.value as string | undefined) ?? null),
        }) as never,
      randomBelow: (max) => {
        bounds.push(max);
        return draws.shift()!;
      },
      random: () => jitter[0]!,
      sleep: (seconds) => Promise.resolve(void sleeps.push(seconds)),
    },
  );
  const result = asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now).then(
    () => null,
    (error: unknown) => error as Error,
  );
  return { sql, recording, result, sleeps, bounds };
}

describe.skipIf(!url)("UpdateSalesRelatedProductsInfosJob", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, recording, result, sleeps, bounds } = await run(c, c.args, c.statements);
      const error = await result;

      // Rails wraps the driver's message in the adapter's exception class name.
      expect(error?.message).toEqual(c.error?.message.replace(/^Mysql2::Error: /u, "") ?? undefined);
      expect(sql.log).toEqual(sql.expected);
      expect(sleeps).toEqual(c.sleeps);
      expect(bounds.every((max) => max === 86_400)).toBe(true);
      expect(bounds.length).toBe(c.rands_used.filter(([callArgs]) => callArgs.length > 0).length);
      // The golden's Redis also holds the flag and the delay the case started from, which Node only reads.
      const written = Object.fromEntries(
        Object.entries(c.redis).filter(([key]) => ![FEATURE, DELAY_KEY, "flipper_features"].includes(key)),
      );
      expect(plain(await recording.snapshot())).toEqual(plain(written));
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const args = c.args.map((arg) => (typeof arg === "number" ? new RubyFloat(arg) : arg));
      const { sql, recording, result } = await run(c, args, []);

      expect((await result)?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(await recording.snapshot()).toEqual({});
    });
  }

  it("hands a delay in Redis past a million hours back before any write", async () => {
    const c = golden.cases.find((c) => c.name === "a delay set in redis")!;
    const huge = {
      ...c,
      redis_before: { ...c.redis_before, [DELAY_KEY]: { type: "string", value: "9999999999", expires: false } },
    };
    const { sql, recording, result } = await run(huge as Case, c.args, c.statements.slice(0, 2));

    expect((await result)?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(await recording.snapshot()).toEqual({});
  });
});
