// Replays schedule-affiliate-workflows.golden.json (scripts/golden/schedule-affiliate-workflows.rb): ScheduleAffiliateWorkflowJobsJob
// with a workflow schedule token, and the DirectAffiliate#schedule_workflow_jobs it calls, run by the real app as a Sidekiq job.
// Node must send the statements Rails sent, given the same answers, push the same Sidekiq payloads and fail with the same errors.
// A case Node hands back to Rails stops before the affiliate's first push or write.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { scheduleAffiliateWorkflowJobsJobWith } from "./workflow-jobs.ts";

type Case = { name: string; args: JsonValue[]; case_now: unknown; error: { class: string; message: string } | null; statements: Statement[]; redis: RedisSnapshot };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/schedule-affiliate-workflows.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

// A stored filter Node does not read (a date that is not ISO 8601, a has-not-clicked reference) goes back to Rails.
const HANDED_BACK = new Set(["an installment with a filter Node does not read", "an installment with a has-not-clicked filter"]);

const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);
const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};

describe("ScheduleAffiliateWorkflowJobsJob with a token", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await redis!.flushdb();
      const nowSeconds = secondsOf(c.case_now);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => scheduleAffiliateWorkflowJobsJobWith({ now, uuid: sequentialUuid(), logError: () => {} })(c.args, contextFor(runtime)), nowSeconds);
      } catch (e) {
        error = e;
      }

      if (HANDED_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        expect(sql.log.some((statement) => statement.startsWith("UPDATE"))).toBe(false);
        expect(await snapshotRedis(redis!)).toEqual({});
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
    });
  }
});

describe("ScheduleAffiliateWorkflowJobsJob with a token Node does not cast", () => {
  const handBack = async (token: JsonValue) => {
    const sql = sqlReplay([]);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => 0, newJid: sequentialJids() });
    await expect(asSidekiqJob(() => scheduleAffiliateWorkflowJobsJobWith({ logError: () => {} })([token], contextFor(runtime)), 0)).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(sql.log).toEqual([]);
  };

  it("hands a Float back before any statement", () => handBack(new RubyFloat(1.5)));
  it("hands an Array back before any statement", () => handBack(["tok"]));
  it("hands a Hash back before any statement", () => handBack({ id: 1 }));
});
