// Replays the Payouts.create_payments cases of payouts-create-payments.golden.json (scripts/golden/payouts-create-payments.rb):
// the real models run by Ruby against a scratch database, with `prepare_payment_and_set_amount` stubbed. Node must send the
// statements Rails sent, in its order, given the answers Rails got.
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../search/__fixtures__/job-harness.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "./link.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { markBalancesProcessing, PAYOUT_TYPE_STANDARD } from "./payouts.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { findUserBang, resetUserCollaborators, setUserCollaborators } from "./user.ts";

type Case = {
  name: string;
  statements: Statement[];
  error: { class: string; message: string } | null;
  redis: Record<string, unknown>;
  cache: [string, string][];
  prepare_calls: unknown[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/payouts-create-payments.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));
const PAYOUT_DATE = new Date("2025-10-31T00:00:00Z");
const byName = (name: string) => golden.cases.find((c) => c.name === name)!;

type Action = () => Promise<unknown>;
// Each action starts with the `User.find(5)` the Ruby case runs outside the method.
const seller = () => findUserBang(5);

async function run(c: Case, statements: Statement[], action: Action) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const cache: [string, string][] = [];
  setSellerProfileCacheForTesting({ delete: (name) => Promise.resolve(void cache.push(["cache_delete", name])) });
  setUserCollaborators({ now });
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
  setLinkCollaborators({
    isFeatureEnabled: () => Promise.resolve(false),
    redis: () => {
      throw new Error("unexpected $redis read");
    },
    cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])),
  });
  const es = esRecorder();
  let error: unknown = null;
  let result: unknown;
  try {
    result = await withJobsRuntime(runtime, action);
  } catch (e) {
    error = e;
  } finally {
    es.restore();
  }
  return { sql, error, cache, result, name: c.name };
}

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

afterEach(() => {
  resetUserCollaborators();
  resetLinkCollaborators();
  resetPayoutReadCollaborators();
});

describe("mark_balances_processing reads", () => {
  const READS: Record<string, Action> = {
    "a seller with no unpaid balance gets no payment": async () =>
      markBalancesProcessing(await seller(), PAYOUT_DATE, PAYOUT_TYPE_STANDARD),
    "a paused seller is not claimed": async () =>
      markBalancesProcessing(await seller(), PAYOUT_DATE, PAYOUT_TYPE_STANDARD),
  };
  for (const [name, action] of Object.entries(READS)) {
    it(name, async () => {
      const c = byName(name);
      const { sql, error } = await run(c, c.statements, action);
      expect(sql.log).toEqual(sql.expected);
      expect(error).toBeNull();
    });
  }
});
