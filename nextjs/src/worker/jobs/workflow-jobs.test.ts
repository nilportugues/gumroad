// Replays workflow-jobs.golden.json (scripts/golden/workflow-jobs.rb): each job run by the real app
// against MySQL as a Sidekiq job, at the frozen time the golden records. Node must send the statements
// Rails sent, given the same answers, push the same Sidekiq payloads (with their `at`) and fail with
// the same errors. The flush job's Redis keys are checked against a scratch Redis, so those cases
// need JOBS_REDIS_URL and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { setSubscriptionAsDeactivatedWorkerWith } from "./subscription-write-jobs.ts";
import type { JobHandler } from "./types.ts";
import { flushInstallmentDeliveredDeltasJobWith, scheduleAffiliateWorkflowJobsJobWith, scheduleWorkflowEmailsWorkerWith, sendWorkflowInstallmentRescheduleJobWith, updateInstallmentEventsCountCacheWorker } from "./workflow-jobs.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  case_now: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/workflow-jobs.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
// The key scripts/golden/workflow-jobs.rb runs under: the variant external ids in its seeds depend on it.
const savedKeys = { cipher: process.env.OBFUSCATE_IDS_CIPHER_KEY, numeric: process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY };
beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "ws51-golden-obfuscate-key";
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

// Puts back the keys the case's setup wrote (strings with their TTL, sets).
async function restore(redis: Redis, before: RedisSnapshot) {
  await redis.flushdb();
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") {
      if (entry.expires) await redis.set(key, String(entry.value), "EX", 172_800);
      else await redis.set(key, String(entry.value));
    }
    else if (entry.type === "set") await redis.sadd(key, ...(entry.value as string[]));
  }
}

const featureActive = (before: RedisSnapshot | undefined) => async (name: string, actor: string | { flipperId: string } | null) => {
  const doc = (before?.[name]?.value ?? {}) as Record<string, string>;
  return evaluateFeature(name, parseGateValues(doc), actor);
};

// SecureRandom.uuid as the generator stubs it.
const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};

// The golden recorded this case with an empty rule-version cache; the worker would otherwise dial the default
// 127.0.0.1:6379, which nothing here provides. A client that rejects every call takes the worker's own
// "cache unreadable, use the rule's version" path without a connection attempt.
const unreachableRedis = recordingSidekiqRedis().redis;

const handlers = (c: Case): Record<string, JobHandler> => {
  const now = () => new Date(Math.round(c.case_now * 1000));
  return {
    ScheduleWorkflowEmailsWorker: scheduleWorkflowEmailsWorkerWith({ now }),
    ScheduleAffiliateWorkflowJobsJob: scheduleAffiliateWorkflowJobsJobWith({ now, uuid: sequentialUuid(), logError: () => {} }),
    UpdateInstallmentEventsCountCacheWorker: updateInstallmentEventsCountCacheWorker,
    FlushInstallmentDeliveredDeltasJob: flushInstallmentDeliveredDeltasJobWith({ now }, { redis: () => realRedis! }),
    SendWorkflowInstallmentRescheduleJob: sendWorkflowInstallmentRescheduleJobWith({ now }, { redis: () => unreachableRedis }),
    SetSubscriptionAsDeactivatedWorker: setSubscriptionAsDeactivatedWorkerWith({ now }, { featureActive: featureActive(c.redis_before) }),
  };
};

const handsBack = (_c: Case) => false;

const isWorkflowRead = (statement: Statement) => statement.sql.startsWith("SELECT `workflows`.*");
const WORKFLOWS_SQL = "SELECT `workflows`.* FROM `workflows` WHERE `workflows`.`seller_id` = 1 AND `workflows`.`deleted_at` IS NULL AND `workflows`.`workflow_type` IN ('seller', 'product', 'variant')";

// Node reads the seller's workflows of a cancelled subscription before the job's first write, where Rails
// reads them after the commit (so that a workflow it cannot judge hands the job back untouched). Rails
// never gets that far when the save raises: the read is then answered with no workflows.
function nodeStatements(c: Case): Statement[] {
  const statements = [...c.statements];
  if (c.job !== "SetSubscriptionAsDeactivatedWorker" || c.statements.length < 2 || c.name.includes("failed rather than")) return statements;
  const read = statements.findIndex(isWorkflowRead);
  const [workflowRead] = read === -1 ? [{ sql: WORKFLOWS_SQL, result: { fields: [], rows: [] } }] : statements.splice(read, 1);
  statements.splice(1, 0, workflowRead!);
  return statements;
}

const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const needsRealRedis = (c: Case) => c.job === "FlushInstallmentDeliveredDeltasJob" || Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));
// What the case's own writes left, without the Flipper documents and seeded keys its setup put there.
const withoutSetup = (redis: RedisSnapshot, before: RedisSnapshot | undefined) =>
  Object.fromEntries(Object.entries(redis).filter(([key, entry]) => JSON.stringify(before?.[key]) !== JSON.stringify(entry)));

describe("workflow and installment jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(needsRealRedis(c) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.job === "SetSubscriptionAsDeactivatedWorker" ? nodeStatements(c) : c.statements);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (needsRealRedis(c)) {
        await restore(realRedis!, c.job === "FlushInstallmentDeliveredDeltasJob" ? (c.redis_before ?? {}) : {});
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = async () => recording.snapshot();
      }
      const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRuntimeRegistry(), now: () => c.case_now, newJid: sequentialJids() });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handlers(c)[c.job]!(c.args, contextFor(runtime)), c.case_now);
      } catch (e) {
        error = e;
      }

      if (handsBack(c)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(await snapshot()).toEqual({});
        return;
      }
      if (process.env.WS51_DEBUG && error) console.log("ERR", String((error as Error).stack).slice(0, 600));
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      const expected = c.job === "FlushInstallmentDeliveredDeltasJob" ? c.redis : withoutSetup(c.redis, c.redis_before);
      expect(JSON.parse(withoutJobIds(await snapshot()))).toEqual(JSON.parse(withoutJobIds(expected)));
    });
  }
});
