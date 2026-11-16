// Replays generate-community-chat-recap-job.golden.json (scripts/golden/generate-community-chat-recap-job.rb): the job run by the real
// app as a Sidekiq job, and its sidekiq_retries_exhausted block. Node sends the statements Rails sent and queues the same unique-locked
// jobs (the weekly run, the notifications). Those pushes run unique-jobs Lua, so the block's cases need a scratch Redis in
// JOBS_REDIS_URL (a database other than 0) and are skipped without one.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";

import {
  asSidekiqJob,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import {
  generateCommunityChatRecapJobRetriesExhaustedWith,
  generateCommunityChatRecapJobWith,
} from "./generate-community-chat-recap-job.ts";

type Case = JobCase & { reaches_generator?: boolean; hook?: boolean; job_class?: string; message?: string };

const golden = loadGolden(
  new URL("./__fixtures__/generate-community-chat-recap-job.golden.json", import.meta.url),
) as unknown as {
  now: number;
  cases: Case[];
};
const nowDate = () => new Date(Math.round(golden.now * 1000));

const isInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value);
const isDigits = (value: unknown) => typeof value === "string" && /^[0-9]{1,15}$/u.test(value);

replayJobGolden(
  "GenerateCommunityChatRecapJob",
  {
    now: golden.now,
    cases: golden.cases.filter((c) => !c.hook).map((c) => ({ ...c, hands_back: Boolean(c.reaches_generator) })),
  },
  generateCommunityChatRecapJobWith(),
  // Rails casts a float or a word and raises for nil; Node hands those arguments back before any statement.
  (c) => c.args.length === 1 && !(isInteger(c.args[0]) || isDigits(c.args[0])),
);

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

const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

describe.skipIf(!url)("GenerateCommunityChatRecapJob, sidekiq_retries_exhausted", () => {
  for (const c of golden.cases.filter((candidate) => candidate.hook)) {
    it(c.name, async () => {
      await redis!.flushdb();
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({
        sidekiqRedis: redis!,
        bullmqRedis: redis!,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const hook = generateCommunityChatRecapJobRetriesExhaustedWith({ now: nowDate });
      const msg = { class: c.job_class, args: c.args } as unknown as SidekiqItem;

      await asSidekiqJob(() => hook(msg, new Error(c.message), { runtime }), golden.now);

      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(await snapshotRedis(redis!))).toEqual(withoutJobIds(c.redis));
    });
  }
});
