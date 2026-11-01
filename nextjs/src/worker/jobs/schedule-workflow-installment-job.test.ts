// Replays schedule-workflow-installment.golden.json (scripts/golden/schedule-workflow-installment.rb): ScheduleWorkflowInstallmentJob,
// Workflow#schedule_installment and WorkflowInstallmentScheduleIntent.enqueue!, run by the real app against MySQL as Sidekiq runs a
// job. Node must send the statements Rails sent, given the same answers, push the same Sidekiq payloads and fail with the same errors.
// A case Node hands back to Rails stops before its first write.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import type { Installment, Workflow } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { findById } from "../../server/models/row-reads.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { WorkflowRecord } from "../../server/models/workflow.ts";
import { enqueueBang } from "../../server/models/workflow-installment-schedule-writes.ts";
import { scheduleInstallment } from "../../server/models/workflow-schedule-installment.ts";
import { asSidekiqJob, contextFor, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { scheduleWorkflowInstallmentJobWith } from "./schedule-workflow-installment-job.ts";

type Case = {
  name: string;
  kind?: "schedule_installment" | "enqueue!";
  job?: string;
  args?: JsonValue[];
  params?: Record<string, unknown>;
  case_now: unknown;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  return?: unknown;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/schedule-workflow-installment.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

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

// A delay edit also re-schedules the memberships that restarted; Node leaves that to Rails.
const HANDED_BACK = new Set(["new customer workflow, delay edit", "new customer workflow, delay edit of a new customers only post"]);

const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};
const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);

class Rollback extends Error {}

describe("ScheduleWorkflowInstallmentJob and the intent writes", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await redis!.flushdb();
      const nowSeconds = secondsOf(c.case_now);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const uuid = sequentialUuid();
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      let result: unknown = null;
      let error: unknown = null;
      try {
        if (c.kind === "schedule_installment") {
          const options = c.params!.options as Record<string, unknown>;
          result = await asSidekiqJob(
            () =>
              withJobsRuntime(runtime, async () => {
                const workflow = new WorkflowRecord((await findById<Workflow>("Workflow", 1))!);
                const installment = (await findById<Installment>("Installment", 10))!;
                return scheduleInstallment(workflow, installment, {
                  oldDelayedDeliveryTime: (options.old_delayed_delivery_time as number | undefined) ?? null,
                  cutoffReferenceTime: new Date(options.cutoff_reference_time as string),
                  rescheduleOnStale: (options.reschedule_on_stale as boolean | undefined) ?? false,
                  minimumRuleVersion: (options.minimum_rule_version as number | undefined) ?? null,
                  scheduleIntentToken: (options.schedule_intent_token as string | undefined) ?? null,
                  scheduleIntentFanoutToken: (options.schedule_intent_fanout_token as string | undefined) ?? null,
                });
              }),
            nowSeconds,
          );
        } else if (c.kind === "enqueue!") {
          const params = c.params!;
          const enqueue = async () => {
            const installment = (await findById<Installment>("Installment", 10))!;
            const expected = params.expected_published_at as string | null;
            const intent = await enqueueBang(
              {
                installmentId: installment.id,
                ruleVersion: params.rule_version as number,
                oldDelayedDeliveryTime: params.old_delayed_delivery_time as number | null,
                cutoffReferenceTime: new Date(params.cutoff_reference_time as string),
                expectedPublishedAt: expected === null ? null : new Date(`${expected.replace(" ", "T")}Z`),
              },
              { now, uuid, logError: () => {} },
            );
            return { token: intent.get("token") };
          };
          const rolledBack = c.name.includes("rolls back");
          result = await asSidekiqJob(
            () =>
              withJobsRuntime(runtime, async () => {
                if (c.name.includes("outside")) return enqueue();
                try {
                  return await transaction(async () => {
                    const intent = await enqueue();
                    if (rolledBack) throw new Rollback();
                    return intent;
                  });
                } catch (e) {
                  if (e instanceof Rollback) return null;
                  throw e;
                }
              }),
            nowSeconds,
          );
        } else {
          await asSidekiqJob(() => scheduleWorkflowInstallmentJobWith({ now, uuid, logError: () => {} })(c.args!, contextFor(runtime)), nowSeconds);
        }
      } catch (e) {
        error = e;
      }

      if (HANDED_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        const performed = sql.log.filter((statement, index) => !(statement === "ROLLBACK" && index === sql.log.length - 1));
        expect(performed).toEqual(sql.expected.slice(0, performed.length));
        expect(performed.some((statement) => statement.startsWith("UPDATE"))).toBe(false);
        expect(await snapshotRedis(redis!)).toEqual({});
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
      if (c.kind === "schedule_installment") expect(result).toBe(c.return);
      if (c.kind === "enqueue!" && c.return !== null) expect(result).toEqual(c.return);
    });
  }
});
