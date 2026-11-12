// Replays enforce-refund-policy-for-seller-job.golden.json (scripts/golden/enforce-refund-policy-for-seller-job.rb):
// EnforceRefundPolicyForSellerJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the purchase, the seller,
// the three dispute-rate counts) and returns where Rails returns; a seller who calls for enforcement is handed back before any write.
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
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { enforceRefundPolicyForSellerJobWith } from "./enforce-refund-policy-for-seller-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/enforce-refund-policy-for-seller-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

describe("EnforceRefundPolicyForSellerJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const handler = enforceRefundPolicyForSellerJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      }
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
