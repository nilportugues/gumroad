// Replays risk-jobs.golden.json (scripts/golden/risk-jobs.rb): each job run by the real app against
// MySQL. The Node handler must send the statements Rails sent, given the same answers.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetRiskCollaborators, setRiskCollaborators } from "../../server/models/user-risk.ts";
import { resetUserCollaborators, setUserCollaborators } from "../../server/models/user.ts";
import { setSellerProfileCacheForTesting } from "../../server/models/seller-profile.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { blockSuspendedAccountIpWorkerWith, checkPaymentAddressWorkerWith } from "./risk-jobs.ts";

type RiskJobCase = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/risk-jobs.golden.json", import.meta.url), "utf8")) as unknown as { now: number; cases: RiskJobCase[] };
const now = () => new Date(Math.round(golden.now * 1000));

const HANDLERS = {
  CheckPaymentAddressWorker: checkPaymentAddressWorkerWith({ now }),
  BlockSuspendedAccountIpWorker: blockSuspendedAccountIpWorkerWith({ now }),
} as const;

afterEach(() => {
  resetUserCollaborators();
  resetRiskCollaborators();
});

describe("risk jobs", () => {
  for (const c of golden.cases) {
    it(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const cache: [string, string][] = [];
      setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
      setUserCollaborators({ now });
      setRiskCollaborators({
        sadd: (key, member) => recording.redis.pipeline().sadd(key, member).exec(),
        srem: (key, member) => recording.redis.pipeline().srem(key, member).exec(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => HANDLERS[c.job as keyof typeof HANDLERS](c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(cache).toEqual(c.cache);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }
});
