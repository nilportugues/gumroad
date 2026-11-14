// Replays the cases of alert-on-stalled-post-email-blasts-job.golden.json in which Rails took a dead entry out of the dead set. That runs
// sidekiq-unique-jobs' delete.lua, so the replay needs a real Redis: a scratch database named by JOBS_REDIS_URL (the cases are skipped
// without it), restored to the case's `redis_before`. Node must leave the same keys and the same changelog entries as Rails did.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  alertOnStalledPostEmailBlastsJobWith,
  stalledBlastRedisOver,
} from "./alert-on-stalled-post-email-blasts-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  changelog: [string, number][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

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

// Dead entries whose digest Node does not derive; the other test file covers their hand-back.
const HANDS_BACK = new Set([
  "a dead blast with unique_across_queues in the entry",
  "a dead blast with no queue in the entry",
]);
const sentBySetup = (s: Statement) => s.sql.startsWith("INSERT INTO sent_post_emails");

const removesDeadEntry = (c: Case) => {
  if (c.name === "a dead blast whose sender reappears busy") return false;
  const before = (c.redis_before?.dead?.value ?? []) as [string, number][];
  const after = new Set(((c.redis.dead?.value ?? []) as [string, number][]).map(([member]) => member));
  return before.some(([member]) => !after.has(member));
};

const scoreOf = (score: number | RubyFloat) => (score instanceof RubyFloat ? score.value : score);

// The golden keeps a score Ruby wrote as a float (1700000000.0) as a RubyFloat; Redis hands it back as a number.
const plainScores = (snapshot: RedisSnapshot): RedisSnapshot =>
  Object.fromEntries(
    Object.entries(snapshot).map(([key, entry]) => [
      key,
      entry.type === "zset" && Array.isArray(entry.value)
        ? { ...entry, value: (entry.value as [string, number | RubyFloat][]).map(([m, sc]) => [m, scoreOf(sc)]) }
        : entry,
    ]),
  ) as RedisSnapshot;

// Puts back what the generator's setup wrote. Nothing in these cases starts with changelog entries.
async function restore(before: RedisSnapshot | undefined) {
  await redis!.flushdb();
  for (const [key, entry] of Object.entries(before ?? {})) {
    const value = entry.value as never;
    if (entry.type === "string") await redis!.set(key, String(value));
    else if (entry.type === "list") await redis!.rpush(key, ...(value as string[]));
    else if (entry.type === "set") await redis!.sadd(key, ...(value as string[]));
    else if (entry.type === "hash") await redis!.hset(key, value as Record<string, string>);
    else if (entry.type === "zset")
      for (const [member, score] of value as [string, number | RubyFloat][])
        await redis!.zadd(key, scoreOf(score), member);
    else throw new Error(`cannot restore ${key} (${entry.type})`);
  }
}

describe.skipIf(!url)("AlertOnStalledPostEmailBlastsJob dead entry removal", () => {
  const cases = golden.cases.filter((c) => removesDeadEntry(c) && !HANDS_BACK.has(c.name));

  it("covers the cases that remove a dead entry", () => {
    expect(cases.length).toBeGreaterThan(8);
  });

  for (const c of cases) {
    it(c.name, async () => {
      await restore(c.redis_before);
      const runtime = createJobsRuntime({
        sidekiqRedis: redis!,
        bullmqRedis: redis!,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const sql = sqlReplay(c.statements.filter((s) => !sentBySetup(s)));
      const handler = alertOnStalledPostEmailBlastsJobWith(
        { now: () => new Date(Math.round(golden.now * 1000)) },
        { redis: () => stalledBlastRedisOver(redis!, redis!) },
      );

      await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);

      expect(sql.log).toEqual(sql.expected);
      expect(await snapshotRedis(redis!)).toEqual(plainScores(c.redis));
      const flat = await redis!.zrange("uniquejobs:changelog", "0", "-1", "WITHSCORES");
      const changelog: [string, number][] = [];
      for (let i = 0; i < flat.length; i += 2) changelog.push([flat[i]!, Number(flat[i + 1])]);
      expect(changelog).toEqual(c.changelog);
    });
  }
});
