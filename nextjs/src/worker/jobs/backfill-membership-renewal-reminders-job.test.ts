// Replays backfill-membership-renewal-reminders-job.golden.json (scripts/golden/backfill-membership-renewal-reminders-job.rb):
// BackfillMembershipRenewalRemindersJob run by the real app as a Sidekiq job. Node sends the statements Rails sent, claims and
// advances the Redis claim and cursor the same way (a real scratch Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test, flushed
// between cases) and pushes the same reminders (Kernel#rand is 0.5 in the golden).
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import { backfillMembershipRenewalRemindersJobWith } from "./backfill-membership-renewal-reminders-job.ts";
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

type Case = {
  name: string;
  args: JsonValue[];
  case_now: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/backfill-membership-renewal-reminders-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

// The Flipper documents the case started from, as `hgetall` returns them.
const featureActive = (before: RedisSnapshot) => async (name: string, actor: string | { flipperId: string } | null) =>
  evaluateFeature(name, parseGateValues((before[name]?.value ?? {}) as Record<string, string>), actor);

async function seed(before: RedisSnapshot) {
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") await redis.set(key, entry.value as string);
    else if (entry.type === "hash") await redis.hset(key, entry.value as Record<string, string>);
    else if (entry.type === "set") await redis.sadd(key, ...(entry.value as string[]));
    else throw new Error(`cannot seed a ${entry.type}`);
  }
}

const withoutJobIds = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID"),
  ) as RedisSnapshot;
// What the case's own writes left, without the Flipper documents `setup:` put there.
const withoutSetup = (after: RedisSnapshot, before: RedisSnapshot) =>
  Object.fromEntries(
    Object.entries(after).filter(([key, entry]) => JSON.stringify(before[key]) !== JSON.stringify(entry)),
  );

describe.skipIf(!url)("BackfillMembershipRenewalRemindersJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const caseNow = typeof c.case_now === "number" ? c.case_now : c.case_now.value;
      await redis.flushdb();
      await seed(c.redis_before);
      const sql = sqlReplay(c.statements);
      const pushes = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: pushes.redis,
        bullmqRedis: pushes.redis,
        registry: rubyRuntimeRegistry(),
        now: () => caseNow,
        newJid: sequentialJids(),
      });
      const handler = backfillMembershipRenewalRemindersJobWith(
        { now: () => new Date(Math.round(caseNow * 1000)) },
        { redis: () => redis, random: () => 0.5, featureActive: featureActive(c.redis_before) },
      );
      let error: Error | null = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), caseNow);
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      const left = withoutSetup(plain(await snapshotRedis(redis)) as RedisSnapshot, c.redis_before);
      expect(withoutJobIds({ ...left, ...pushes.snapshot() })).toEqual(
        withoutJobIds(plain(withoutSetup(c.redis, c.redis_before)) as RedisSnapshot),
      );
    });
  }
});
