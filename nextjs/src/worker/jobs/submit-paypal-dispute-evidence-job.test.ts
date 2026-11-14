// Replays submit-paypal-dispute-evidence-job.golden.json (scripts/golden/submit-paypal-dispute-evidence-job.rb): the job run by the real
// app as a Sidekiq job. Node reads the Flipper feature as the recording set it, sends the `Dispute.find` Rails sent, ends the job where a
// guard returns, and hands a dispute that passes them back to Rails before its purchases are read.
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
import { submitPaypalDisputeEvidenceJobWith } from "./submit-paypal-dispute-evidence-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/submit-paypal-dispute-evidence-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Flipper rolls this one per call: the recorded run happened to roll "off", Node cannot know.
const COIN_FLIP = "the feature at 50 percent of time";
const wrongArity = (c: Case) => c.args.length !== 1;
// Rails casts a float or a word to an id; Node hands those arguments back instead. nil is Rails' own error.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const featureOn = (c: Case) => {
  const doc = (c.redis_before.submit_paypal_dispute_evidence?.value ?? {}) as Record<string, string>;
  return doc.boolean === "true" || doc.percentage_of_time === "100";
};

async function run(c: Case) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(c.statements);
  const handler = submitPaypalDisputeEvidenceJobWith(
    {},
    {
      redis: () => ({
        hgetall: (key) => Promise.resolve((c.redis_before[key]?.value ?? {}) as Record<string, string>),
      }),
    },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("SubmitPaypalDisputeEvidenceJob", () => {
  for (const c of golden.cases.filter((c) => c.name !== COIN_FLIP)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c);

      if (!wrongArity(c) && featureOn(c) && castByRails(c.args[0])) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
      } else if (c.hands_back) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected);
      } else {
        expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
      }
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a feature at a partial percentage of time back before any read", async () => {
    const { error, sql } = await run(golden.cases.find((c) => c.name === COIN_FLIP)!);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });
});
