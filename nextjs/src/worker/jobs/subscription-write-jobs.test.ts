// Replays subscription-writes-jobs.golden.json (scripts/golden/subscription-writes-jobs.rb): each job
// run by the real app against MySQL as a Sidekiq job, at the frozen time the golden records. Node must
// send the statements Rails sent, given the same answers, push the same Sidekiq payloads (the mail and
// webhook jobs, the Elasticsearch and audience refreshes, unique-jobs locks) and fail with the same errors.
// Cases Node hands back stop at the last statement it can decide on, with nothing pushed.
// Cases that push a unique job need JOBS_REDIS_URL (a scratch database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { endSubscriptionWorkerWith, setSubscriptionAsDeactivatedWorkerWith, unsubscribeAndFailWorkerWith } from "./subscription-write-jobs.ts";
import type { JobHandler } from "./types.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  case_now: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/subscription-writes-jobs.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

// The Flipper documents the case started from, as `hgetall` returns them.
function featureActive(before: RedisSnapshot) {
  return async (name: string, actor: string | { flipperId: string } | null) => {
    const doc = (before[name]?.value ?? {}) as Record<string, string>;
    return evaluateFeature(name, parseGateValues(doc), actor);
  };
}

const handlers = (c: Case): Record<string, JobHandler> => {
  const now = () => new Date(Math.round(c.case_now * 1000));
  const extras = { featureActive: featureActive(c.redis_before) };
  return {
    EndSubscriptionWorker: endSubscriptionWorkerWith({ now }, extras),
    UnsubscribeAndFailWorker: unsubscribeAndFailWorkerWith({ now }, extras),
    SetSubscriptionAsDeactivatedWorker: setSubscriptionAsDeactivatedWorkerWith({ now }, extras),
  };
};

// A failed charge on the card needs Purchase#indian_card_mandate_error_status, and a member
// cancellation workflow needs Workflow#applies_to_purchase?.
const failedChargeOnCard = (c: Case) => c.name === "unsubscribe: mandate reliability on, card with a failed charge";
const memberCancellationWorkflow = (c: Case) => c.name === "deactivated: cancelled, seller has a member cancellation workflow";
const handsBack = (c: Case) => failedChargeOnCard(c) || memberCancellationWorkflow(c);

const isWorkflowRead = (statement: Statement) => statement.sql.startsWith("SELECT `workflows`.*");
const WORKFLOWS_SQL = "SELECT `workflows`.* FROM `workflows` WHERE `workflows`.`seller_id` = 1 AND `workflows`.`deleted_at` IS NULL AND `workflows`.`workflow_type` IN ('seller', 'product', 'variant')";

// Node reads the seller's workflows of a cancelled subscription before the job's first write, where
// Rails reads them after the commit, so a member cancellation workflow can be handed back while
// nothing has been written. Rails never gets that far when the save raises: the read is then answered
// with the seller having no workflows, which is what those cases seed.
function nodeStatements(c: Case): Statement[] {
  const statements = [...c.statements];
  if (c.job !== "SetSubscriptionAsDeactivatedWorker" || !c.name.includes("cancelled") || c.statements.length < 2) return statements;
  const read = statements.findIndex(isWorkflowRead);
  const [workflowRead] = read === -1 ? [{ sql: WORKFLOWS_SQL, result: { fields: [], rows: [] } }] : statements.splice(read, 1);
  statements.splice(1, 0, workflowRead!);
  return statements;
}

const withoutJobIds = (value: unknown) => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const takesLocks = (redis: RedisSnapshot) => Object.keys(redis).some((key) => key.startsWith("uniquejobs"));
// What the case's own writes left, without the Flipper documents `setup:` put there.
const withoutSetup = (redis: RedisSnapshot, before: RedisSnapshot) => Object.fromEntries(Object.entries(redis).filter(([key, entry]) => JSON.stringify(before[key]) !== JSON.stringify(entry)));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

describe("subscription write jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c.redis) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(nodeStatements(c));
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c.redis)) {
        await realRedis!.flushdb();
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
        const expected = sql.expected;
        expect(sql.log).toEqual(expected.slice(0, sql.log.length));
        expect(sql.log.length).toBeGreaterThan(0);
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(JSON.parse(withoutJobIds(await snapshot()))).toEqual(JSON.parse(withoutJobIds(withoutSetup(c.redis, c.redis_before))));
    });
  }
});
