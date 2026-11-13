// Replays send-workflow-emails-to-past-canceled-members-job.golden.json (scripts/golden/send-workflow-emails-to-past-canceled-members-job.rb):
// SendWorkflowEmailsToPastCanceledMembersJob run by the real app as a Sidekiq job. Node must send the statements Rails sent, given the
// same answers, cache the same rule version, push the same Sidekiq payloads and fail with the same errors. A call Node hands back to
// Rails stops before the rule version is cached and before any push.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

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
import { sendWorkflowEmailsToPastCanceledMembersJobWith } from "./send-workflow-emails-to-past-canceled-members-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  case_now: unknown;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/send-workflow-emails-to-past-canceled-members-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
// The keys scripts/golden/send-workflow-emails-to-past-canceled-members-job.rb ran with (a variant workflow reads external variant ids)
const KEYS = { OBFUSCATE_IDS_CIPHER_KEY: "ws63-golden-obfuscate-key", OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "123456789" };
const savedKeys = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(KEYS)) {
    savedKeys.set(key, process.env[key]);
    process.env[key] = value;
  }
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  for (const [key, value] of savedKeys) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

// Shapes of the cutoff and the old delay that Ruby reads but Node does not (see the job's header).
const HANDED_BACK = new Set([
  "a reschedule with a cutoff with an offset",
  "a reschedule with a cutoff with a fraction",
  "a reschedule with a cutoff without a zone",
  "a reschedule with a cutoff that is a date only",
  "a reschedule with a cutoff that is not a time",
  "a reschedule with a cutoff past the end of the month",
  "a reschedule with an old delay that is a string",
  "a reschedule with an old delay that is a float",
]);

const withoutJobIds = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
    "JOB_ID",
  );
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);

async function restore(client: Redis, before: RedisSnapshot) {
  await client.flushdb();
  for (const [key, entry] of Object.entries(before)) await client.set(key, String(entry.value));
}

async function run(args: JsonValue[], nowSeconds: number) {
  const now = () => new Date(Math.round(nowSeconds * 1000));
  const runtime = createJobsRuntime({
    sidekiqRedis: redis!,
    bullmqRedis: redis!,
    registry: rubyRuntimeRegistry(),
    now: () => nowSeconds,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(
      () => sendWorkflowEmailsToPastCanceledMembersJobWith({ now }, { redis: () => redis! })(args, contextFor(runtime)),
      nowSeconds,
    );
  } catch (e) {
    error = e as Error;
  }
  return error;
}

describe("SendWorkflowEmailsToPastCanceledMembersJob", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await restore(redis!, c.redis_before ?? {});
      const nowSeconds = secondsOf(c.case_now);
      const sql = sqlReplay(c.statements);
      const error = await run(c.args, nowSeconds);

      if (HANDED_BACK.has(c.name)) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        expect(await snapshotRedis(redis!)).toEqual(c.redis_before ?? {});
        return;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      // Node raises Ruby's NoMethodError and TypeError as a TypeError with Ruby's message
      if (error !== null && c.error!.class.includes("::")) expect(error.name).toEqual(c.error!.class);
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
    });
  }

  const caseNamed = (name: string) => golden.cases.find((c) => c.name === name)!;

  describe("calls handed back before any statement", () => {
    for (const [name, args] of [
      ["an intent token", [10, null, null, null, "token"]],
      ["a fanout token", [10, null, null, null, null, "token"]],
      ["both tokens", [10, null, null, null, "token", "fanout"]],
      ["an installment id that is not an Integer", [1.5]],
      ["an installment id that is a word", ["abc"]],
      ["a minimum rule version that is a string", [10, null, null, "3"]],
      ["a minimum rule version that is a float", [10, null, null, 3.5]],
    ] as [string, JsonValue[]][]) {
      it(`hands ${name} back`, async () => {
        const sql = sqlReplay([]);
        const recording = recordingSidekiqRedis();
        const runtime = createJobsRuntime({
          sidekiqRedis: recording.redis,
          bullmqRedis: recording.redis,
          registry: rubyRuntimeRegistry(),
          now: () => 0,
          newJid: sequentialJids(),
        });
        await expect(
          asSidekiqJob(() => sendWorkflowEmailsToPastCanceledMembersJobWith()(args, contextFor(runtime)), 0),
        ).rejects.toMatchObject({ name: "HandBackToRuby" });
        expect(sql.log).toEqual([]);
        expect(recording.snapshot()).toEqual({});
      });
    }

    it("treats blank tokens as absent", async () => {
      const c = caseNamed("a member cancelled before the post was scheduled");
      const sql = sqlReplay(c.statements);
      await restore(redis!, {});
      const error = await run([10, null, null, null, "", "  "], secondsOf(c.case_now));
      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
    });
  });

  describe.skipIf(!url)("calls handed back after reading", () => {
    // The baseline case with one answer changed
    const altered = (name: string, change: (statements: Statement[]) => void) => {
      const c = caseNamed(name);
      const statements = structuredClone(c.statements);
      change(statements);
      return { c, statements };
    };

    it("hands back a workflow with a filter Node does not read before caching the rule version", async () => {
      const { c, statements } = altered("a member cancelled before the post was scheduled", (all) => {
        const result = all[1]!.result!;
        const index = result.fields!.indexOf("json_data");
        result.rows![0]![index] = JSON.stringify({ workflow_trigger: "member_cancellation", created_after: "soon" });
      });
      await restore(redis!, {});
      const sql = sqlReplay(statements);
      const error = await run(c.args, secondsOf(c.case_now));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, 3));
      expect(await snapshotRedis(redis!)).toEqual({});
    });

    it("hands back a first batch of 1000 members before pushing anything", async () => {
      const { c, statements } = altered("a member cancelled before the post was scheduled", (all) => {
        const result = all[3]!.result!;
        const row = result.rows![0]!;
        const idIndex = result.fields!.indexOf("id");
        result.rows = Array.from({ length: 1000 }, (_, i) => row.map((value, j) => (j === idIndex ? i + 1 : value)));
      });
      await restore(redis!, {});
      const sql = sqlReplay(statements);
      const error = await run(c.args, secondsOf(c.case_now));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, 4));
      expect(
        Object.keys(await snapshotRedis(redis!)).filter((key) => key !== "workflow_installment_rule:10:version"),
      ).toEqual([]);
    });
  });
});
