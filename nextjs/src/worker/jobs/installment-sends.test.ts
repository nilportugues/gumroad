// Replays installment-sends.golden.json (scripts/golden/installment-sends.rb): SendLastPostJob, and the reschedule paths of
// SendWorkflowInstallmentWorker and SendWorkflowInstallmentRescheduleJob, run by the real application in production mode as
// Sidekiq jobs, with the provider clients replaced by recorders.
// Node must send the statements Rails sent, given the same answers, make the same provider requests, leave
// the same Redis and fail with the same errors. A case Node hands back to Rails stops where the port refuses:
// before any write, or (after the claim) with the claim deleted again.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { useGoldenEnvironment } from "../../server/mail/__fixtures__/application-mailer-golden.ts";
import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import type { ProviderTransport } from "../../server/models/post-email-api.ts";
import { asSidekiqJob, contextFor, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { sendLastPostJobWith } from "./send-last-post-job.ts";
import { sendWorkflowInstallmentWorkerWith } from "./send-workflow-installment-worker.ts";
import { sendWorkflowInstallmentRescheduleJobWith } from "./workflow-jobs.ts";

type Provider = { provider: string; kind?: string; api_key: string; request: unknown };
type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  case_now: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  providers: Provider[];
  ivs: string[];
  rands_used: number[];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/installment-sends.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
let restoreEnvironment: () => void;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  restoreEnvironment = useGoldenEnvironment();
  // The keys scripts/golden/installment-sends.rb ran with
  const env: Record<string, string> = {
    MAILER_HEADERS_ENCRYPTION_KEY_V1: "ws59-golden-header-key",
    OBFUSCATE_IDS_CIPHER_KEY: "ws59-golden-obfuscate-key",
    OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "123456789",
    SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: "1",
    SECURE_EXTERNAL_ID__KEYS__1: "ws59-secure-external-id-key-0001",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  restoreEnvironment();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

// Puts back the keys the case's setup wrote (strings with their TTL, sets).
async function restore(client: Redis, before: RedisSnapshot) {
  await client.flushdb();
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") await client.set(key, String(entry.value));
    else if (entry.type === "set") await client.sadd(key, ...(entry.value as string[]));
  }
}

const featureActive = (before: RedisSnapshot) => async (name: string, actor: string | { flipperId: string } | null) => {
  const doc = (before[name]?.value ?? {}) as Record<string, string>;
  return evaluateFeature(name, parseGateValues(doc), actor);
};

// Cases Node leaves to Rails, with where it stops: "before" any write, "claim" after the SentPostEmail row is
// written (and deleted again).
const HANDED_BACK: Record<string, "before" | "claim"> = {
  "last post: a post with files": "claim",
  "last post: a post with a filter Node does not read": "before",
};

const withoutSetup = (snapshot: RedisSnapshot, before: RedisSnapshot) =>
  Object.fromEntries(Object.entries(snapshot).filter(([key, entry]) => JSON.stringify(before[key]) !== JSON.stringify(entry)));
const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

describe("SendLastPostJob, SendWorkflowInstallmentWorker and SendWorkflowInstallmentRescheduleJob", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      const handedBack = HANDED_BACK[c.name];
      // A float with no fraction is a RubyFloat.
      const nowSeconds = typeof c.case_now === "number" ? c.case_now : (c.case_now as unknown as { value: number }).value;
      const sql = sqlReplay(c.statements);
      await restore(redis!, c.redis_before);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      const calls: Provider[] = [];
      const transport: ProviderTransport = {
        async sendgrid(apiKey, body) {
          calls.push({ provider: "sendgrid", api_key: apiKey, request: body });
          return failures.length > 0 ? { status: failures.shift()!, body: "rejected" } : { status: 202, body: "" };
        },
        async resend(apiKey, kind, body) {
          calls.push({ provider: "resend", kind, api_key: apiKey, request: body });
          return failures.length > 0 ? { status: failures.shift()!, body: "rejected" } : { status: 200, body: "{}" };
        },
      };
      const failures = c.name.endsWith("rejects") ? [c.name.includes("sendgrid") ? 500 : 422] : [];
      const ivs = c.ivs.map((iv) => Buffer.from(iv, "base64"));
      const rands = [...c.rands_used];
      const active = featureActive(c.redis_before);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const today = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
      const send: Parameters<typeof sendWorkflowInstallmentWorkerWith>[1] = {
          now,
          featureActive: active,
          randomIv: () => ivs.shift()!,
          transport,
          redis: () => redis!,
          deliver: () => true,
          sleep: async () => {},
          log: () => {},
          router: {
            featureActive: (name: string) => active(name, null),
            redisGet: (key: string) => redis!.get(key),
            redisIncr: (key: string) => redis!.incr(key),
            rand: () => rands.shift()!,
            today: () => today,
          },
          subscriptionDeps: { now, featureActive: active },
        };
      const factories = { SendLastPostJob: sendLastPostJobWith, SendWorkflowInstallmentWorker: sendWorkflowInstallmentWorkerWith, SendWorkflowInstallmentRescheduleJob: sendWorkflowInstallmentRescheduleJobWith };
      const handler = factories[c.job as keyof typeof factories]({ now }, send);
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), nowSeconds);
      } catch (e) {
        error = e;
      }

      if (handedBack !== undefined) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(calls).toEqual([]);
        if (handedBack === "before") {
          // Only reads, in Ruby's order.
          expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
          expect(withoutSetup(await snapshotRedis(redis!), c.redis_before)).toEqual({});
        } else {
          expect(sql.log.at(-1)).toMatch(/^DELETE FROM `sent_post_emails` WHERE `sent_post_emails`\.`post_id` = 10 AND `sent_post_emails`\.`email` = /u);
          const performed = sql.log.slice(0, -1);
          expect(performed).toEqual(sql.expected.slice(0, performed.length));
          expect(performed.some((statement) => statement.startsWith("INSERT INTO `sent_post_emails`"))).toBe(true);
        }
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(calls).toEqual(c.providers);
      expect(ivs).toEqual([]);
      const after = withoutSetup(await snapshotRedis(redis!), c.redis_before);
      expect(JSON.parse(withoutJobIds(after))).toEqual(JSON.parse(withoutJobIds(withoutSetup(c.redis, c.redis_before))));
    });
  }
});
