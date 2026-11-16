// Replays order-review-reminder-job.golden.json (scripts/golden/order-review-reminder-job.rb): OrderReviewReminderJob run by the real
// app as a Sidekiq job. Node sends the statements Rails sent (the order's purchases, the gift hops, each eligibility read, the
// marker check and insert), pushes the same CustomerLowPriorityMailer jobs and stops where Rails stops when a push fails. An address
// with a non-ASCII letter, and an order id that is not an Integer or its digits, are handed back.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { orderReviewReminderJobWith } from "./order-review-reminder-job.ts";

const PUSH_FAILED = "push failed";
// The replay answers the statements Rails sent, so the cases that Node hands back start from the same first read.
const HANDED_BACK = new Set([
  "two addresses that differ only by a non ASCII letter case",
  "an order id given as a float",
  "an order id given as nil",
  "an order id given as a word",
]);

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/order-review-reminder-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Pushes after the first `succeed` ones fail, as a Sidekiq outage would.
function runtimeFor(failAt: number | null) {
  const recording = recordingSidekiqRedis();
  let pushes = 0;
  const redis =
    failAt === null
      ? recording.redis
      : (new Proxy(recording.redis, {
          get(target, property) {
            if (property !== "pipeline") return Reflect.get(target, property);
            return () => {
              const inner = target.pipeline() as unknown as Record<string, (...a: unknown[]) => unknown>;
              const chain: Record<string, unknown> = {
                sadd: (...a: unknown[]) => (inner.sadd!(...a), chain),
                lpush: (...a: unknown[]) => (inner.lpush!(...a), chain),
                exec: () => (++pushes === failAt ? Promise.reject(new Error(PUSH_FAILED)) : inner.exec!()),
              };
              return chain;
            };
          },
        }) as typeof recording.redis);
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  return { runtime, recording };
}

async function run(args: JsonValue[], statements: Statement[], failAt: number | null = null) {
  const { runtime, recording } = runtimeFor(failAt);
  const sql = sqlReplay(statements);
  const handler = orderReviewReminderJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

// Which push the case makes fail: the generator names it in the case.
const FAIL_AT: Record<string, number> = {
  "the second purchase reminder fails to enqueue": 2,
  "the first purchase reminder fails to enqueue": 1,
  "the order reminder fails to enqueue": 1,
};

describe("OrderReviewReminderJob", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c.args, c.statements, FAIL_AT[c.name] ?? null);

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  it("hands an address that differs only by a non-ASCII letter case back before any write", async () => {
    const c = golden.cases.find((c) => c.name === "two addresses that differ only by a non ASCII letter case")!;
    const eligibilityReads = c.statements.findIndex((s) => s.sql.startsWith("SELECT 1 AS one"));
    const { error, sql, recording } = await run(c.args, c.statements.slice(0, eligibilityReads));

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });

  for (const [name, id] of [
    ["a float", 1.5],
    ["nil", null],
    ["a word", "abc"],
  ] as [string, JsonValue][]) {
    it(`hands an order id given as ${name} back before any statement`, async () => {
      const { error, sql } = await run([id], []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }
});
