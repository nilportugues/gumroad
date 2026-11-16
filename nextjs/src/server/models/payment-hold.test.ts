// Replays the user-hold cases of payouts-create-payments.golden.json (scripts/golden/payouts-create-payments.rb): the real
// StripePayoutProcessor hold, run by Ruby against a scratch database. Node must send the statements Rails sent.
// The `Payouts.create_payments` cases of the same golden are recorded but not ported yet (docs/nextjs-rewrite/parity-debt.md).
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../search/__fixtures__/job-harness.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "./link.ts";
import { holdPayoutsForUnaccountedMoneyBang, reverseInternalTransferOrHoldPayoutsBang } from "./payment-hold.ts";
import { findPaymentBang } from "./payment.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { resetUserCollaborators, setUserCollaborators } from "./user.ts";

type Case = {
  name: string;
  statements: Statement[];
  error: { class: string; message: string } | null;
  redis: Record<string, unknown>;
  cache: [string, string][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/payouts-create-payments.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

const UNKNOWN = "payout_outcome_unknown";
const ACTIONS: Record<string, () => Promise<unknown>> = {
  "a payout outcome unknown holds payouts and comments": async () =>
    reverseInternalTransferOrHoldPayoutsBang(await findPaymentBang(7), UNKNOWN, { now }),
  "a processor_unavailable failure with no internal transfer holds nothing": async () =>
    reverseInternalTransferOrHoldPayoutsBang(await findPaymentBang(7), "processor_unavailable", { now }),
  "the hold comment is written even when the seller is already paused": async () =>
    holdPayoutsForUnaccountedMoneyBang(await findPaymentBang(7), UNKNOWN, { now }),
  "the hold comment is not repeated for the same payout": async () => {
    // The Ruby case reuses one Payment instance, so its user is loaded once and keeps the flag the first call set.
    const payment = await findPaymentBang(7);
    await holdPayoutsForUnaccountedMoneyBang(payment, UNKNOWN, { now });
    await holdPayoutsForUnaccountedMoneyBang(payment, UNKNOWN, { now });
  },
};
// Recorded from Payouts.create_payments; the Node port is the next slice.
const NOT_PORTED_YET = golden.cases.map((c) => c.name).filter((name) => !(name in ACTIONS));

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

afterEach(() => {
  resetUserCollaborators();
  resetLinkCollaborators();
});

describe("payout hold after an unaccounted outcome", () => {
  it("lists every golden case it does not replay as a create_payments case", () => {
    expect(NOT_PORTED_YET.length).toBeGreaterThan(0);
    expect(NOT_PORTED_YET.every((name) => !/hold|processor_unavailable failure/u.test(name))).toBe(true);
  });

  for (const c of golden.cases.filter((candidate) => candidate.name in ACTIONS)) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
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
      setLinkCollaborators({
        isFeatureEnabled: () => Promise.resolve(false),
        redis: () => {
          throw new Error("unexpected $redis read");
        },
        cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])),
      });
      const es = esRecorder();
      let error: unknown = null;
      try {
        await withJobsRuntime(runtime, ACTIONS[c.name]!);
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(cache).toEqual(c.cache);
    });
  }
});
