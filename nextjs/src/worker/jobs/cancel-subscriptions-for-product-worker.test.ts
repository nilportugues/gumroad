// Replays cancel-subscriptions-for-product-worker.golden.json (scripts/golden/cancel-subscriptions-for-product-worker.rb):
// CancelSubscriptionsForProductWorker run by the real app as a Sidekiq job. Node sends the product read and the active-subscriptions
// query Rails sent and pushes the same MailDeliveryJob on the critical queue, or fails with the same error; a deleted product with an
// active subscription is handed back right after that query, before anything is written or pushed. An id Rails casts (nil, a float,
// a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { cancelSubscriptionsForProductWorkerWith } from "./cancel-subscriptions-for-product-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  at: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/cancel-subscriptions-for-product-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

const seconds = (at: number | RubyFloat) => (at instanceof RubyFloat ? at.value : at);

const CAST_IDS = new Set(["a product id of nil", "a product id given as a float", "a product id given as a word"]);
// Rails ran Subscription#cancel_effective_immediately! (and failed on the bare seeded rows): Node hands these back after the query.
const cancelsSubscriptions = (c: Case) => c.statements.length > 2 && !CAST_IDS.has(c.name);

async function run(args: JsonValue[], at: number, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => at,
    newJid: sequentialJids(),
  });
  const handler = cancelSubscriptionsForProductWorkerWith({ now: () => new Date(Math.round(at * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), at);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("CancelSubscriptionsForProductWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !cancelsSubscriptions(c))) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, seconds(c.at), c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  for (const c of golden.cases.filter(cancelsSubscriptions)) {
    it(`hands ${c.name} back after reading the subscriptions`, async () => {
      const { sql, recording, error } = await run(c.args, seconds(c.at), c.statements.slice(0, 2));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, recording, error } = await run(c.args, seconds(c.at), []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { error } = await run([], seconds(golden.cases[0]!.at), []);

    expect(error).not.toBeNull();
  });
});
