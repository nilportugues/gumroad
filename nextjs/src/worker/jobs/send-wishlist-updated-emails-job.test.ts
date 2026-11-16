// Replays send-wishlist-updated-emails-job.golden.json (scripts/golden/send-wishlist-updated-emails-job.rb): SendWishlistUpdatedEmailsJob
// run by the real app as a Sidekiq job. Node sends the statements Rails sent (the wishlist, the product checks, the followers, each
// follower's sent key, the key insert and the wishlist update), pushes the same MailDeliveryJob per follower and fails with the same
// validation error when the wishlist cannot be saved.
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
import { sendWishlistUpdatedEmailsJobWith } from "./send-wishlist-updated-emails-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/send-wishlist-updated-emails-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = sendWishlistUpdatedEmailsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

async function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error, recording };
}

// Ties at millisecond precision cannot be told apart from a microsecond difference.
const TIES = new Set(["a follower who joined at the moment the product was added"]);
// A newer product ends the run in Rails; Node cannot tell it from a microsecond the rounded timestamp lost, so Ruby decides.
const NEWER = new Set([
  "a newer product than the batch ends the run",
  "a product added after the last contact is newer",
]);
// The replay answers from the recording, where Rails saw no newer product; a real database, asked with the rounded literal, answers yes.
const MICROSECONDS = "a follower who joined a microsecond after the product";

describe("SendWishlistUpdatedEmailsJob", () => {
  for (const c of golden.cases.filter((c) => !TIES.has(c.name) && !NEWER.has(c.name) && c.name !== MICROSECONDS)) {
    it(c.name, async () => {
      const { sql, error, recording } = await run(c.args, c.statements);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  for (const c of golden.cases.filter((c) => TIES.has(c.name))) {
    it(`hands ${c.name} back before the mail is queued`, async () => {
      // Up to the sent-key check and the products load.
      const { sql, error, recording } = await run(c.args, c.statements.slice(0, 7));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => NEWER.has(c.name))) {
    it(`hands ${c.name} back before the followers are read`, async () => {
      // The wishlist and the two product reads match; the third read is where the rounded timestamp can differ from Rails' literal.
      const { sql, error, recording } = await run(c.args, c.statements.slice(0, 4));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log.slice(0, 3)).toEqual(sql.expected.slice(0, 3));
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a product the rounded timestamp matches back, as a database asked with the rounded literal would answer", async () => {
    const c = golden.cases.find((c) => c.name === MICROSECONDS)!;
    const statements = c.statements
      .slice(0, 4)
      .map((s, i) => (i === 3 ? { ...s, result: { fields: ["one"], rows: [[1]] } } : s));
    const { error, recording } = await run(c.args, statements);

    expect(error?.name).toBe("HandBackToRuby");
    expect(recording.snapshot()).toEqual({});
  });

  for (const [name, args] of [
    ["a float wishlist id", [1.5, [1]]],
    ["a null wishlist id", [null, [1]]],
    ["product ids that are not a list", [1, 1]],
    ["a null list of product ids", [1, null]],
    ["a word among the product ids", [1, [1, "abc"]]],
    ["a float among the product ids", [1, [1.5]]],
  ] as [string, JsonValue[]][]) {
    it(`hands ${name} back before any statement`, async () => {
      const { sql, error, recording } = await run(args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
