// Replays seller-update-worker.golden.json (scripts/golden/seller-update-worker.rb): SellerUpdateWorker run by the real app as a
// Sidekiq job. Node sends the statements Rails sent (the user, the nine statements of last week's net, then the follower count only
// when the net is not positive) and pushes the same MailDeliveryJob on the critical queue, or fails with the same error. An id that
// is not an Integer or its digits hands back before any statement.
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
import { sellerUpdateWorkerWith } from "./seller-update-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  at: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/seller-update-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

// A whole-second clock parses as a RubyFloat, which keeps 1797325200.0 distinct from the Integer.
const seconds = (at: number | RubyFloat) => (at instanceof RubyFloat ? at.value : at);

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
  const handler = sellerUpdateWorkerWith({ now: () => new Date(Math.round(at * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), at);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("SellerUpdateWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, seconds(c.at), c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  for (const [name, id] of [
    ["a Float id", new RubyFloat(1)],
    ["a nil id", null],
    ["an id with a sign", "+1"],
  ] as const) {
    it(`hands ${name} back before any statement`, async () => {
      const { sql, recording, error } = await run([id], seconds(golden.cases[0]!.at), []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { sql, error } = await run([], seconds(golden.cases[0]!.at), []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
