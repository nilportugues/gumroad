// Replays enforce-refund-policy-for-seller-job.golden.json (scripts/golden/enforce-refund-policy-for-seller-job.rb):
// EnforceRefundPolicyForSellerJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the purchase, the seller,
// the three dispute-rate counts) and returns where Rails returns; a seller past the rate is enforced in one transaction (user, policy,
// comment) and the notification mail is pushed after it commits.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";
import { setSellerProfileCacheForTesting } from "../../server/models/seller-profile.ts";
import { resetUserCollaborators, setUserCollaborators } from "../../server/models/user.ts";
import { esRecorder } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { enforceRefundPolicyForSellerJobWith, formatOneDecimal } from "./enforce-refund-policy-for-seller-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  es: { method: string; path: string; query: string | null; body: string | null }[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/enforce-refund-policy-for-seller-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator drew them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

const now = () => new Date(Math.round(golden.now * 1000));

afterEach(() => {
  resetUserCollaborators();
  resetLinkCollaborators();
});

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
      const cache: [string, string][] = [];
      setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
      setUserCollaborators({ now });
      setLinkCollaborators({
        isFeatureEnabled: async () => false,
        redis: () => {
          throw new Error("unexpected $redis read");
        },
        cacheDelete: async (name) => void cache.push(["cache_delete", name]),
      });
      const es = esRecorder();
      const handler = enforceRefundPolicyForSellerJobWith({ now });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(cache).toEqual(c.cache);
      expect(es.requests).toEqual(c.es);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  it("formats a rate like Kernel#format with %.1f, rounding an exact tie to the even digit", () => {
    expect(
      [1.25, 2.25, 3.75, 16.666666666666668, 100, 1.0033444816053512, 0.05, 33.35, 99.95].map(formatOneDecimal),
    ).toEqual(["1.2", "2.2", "3.8", "16.7", "100.0", "1.0", "0.1", "33.4", "100.0"]);
  });
});
