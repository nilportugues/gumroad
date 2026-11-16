// Replays retry-stripe-jp-address-resync-for-seller-job.golden.json (scripts/golden/retry-stripe-jp-address-resync-for-seller-job.rb):
// RetryStripeJpAddressResyncForSellerJob run by the real app as a Sidekiq job with the Stripe manager replaced by a recorder. Node sends
// the statements Rails sent for every exit before the manager call and fails with the same error; a seller whose manager call was
// recorded (`manager_calls`) is handed back right after the requests are read, with nothing written. A seller on the merchant_migration
// feature, a json_data Ruby's parser rejects and an id Rails casts hand back earlier.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { retryStripeJpAddressResyncForSellerJobWith } from "./retry-stripe-jp-address-resync-for-seller-job.ts";

const flipper = vi.hoisted(() => ({ merchantMigration: false }));
vi.mock("../../server/infra/flipper.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/infra/flipper.ts")>()),
  isFeatureEnabled: () => Promise.resolve(flipper.merchantMigration),
}));

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  manager_calls: unknown[];
  merchant_migration: boolean;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/retry-stripe-jp-address-resync-for-seller-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const NOW = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

const CAST_IDS = new Set(["a user id given as a float", "a user id given as a word"]);
// Rails' JSON parser raises its own error on this json_data; Node hands back.
const UNPARSEABLE = "a user with a request whose json is not json";
const PAYPAL_ACCOUNT = "a user whose account is a PayPal account";
const requestsRead = (c: Case) =>
  c.statements.findIndex((s) => s.sql.startsWith("SELECT `user_compliance_info_requests`.*")) + 1;

async function run(c: Case, statements: Statement[], args: JsonValue[] = c.args) {
  flipper.merchantMigration = c.merchant_migration;
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  const handler = retryStripeJpAddressResyncForSellerJobWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

const finishes = (c: Case) =>
  !CAST_IDS.has(c.name) &&
  c.name !== UNPARSEABLE &&
  c.name !== PAYPAL_ACCOUNT &&
  c.manager_calls.length === 0 &&
  !c.merchant_migration;
const callsManager = (c: Case) => !CAST_IDS.has(c.name) && c.manager_calls.length > 0 && !c.merchant_migration;

describe("RetryStripeJpAddressResyncForSellerJob", () => {
  for (const c of golden.cases.filter(finishes)) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter(callsManager)) {
    it(`hands ${c.name} back before the manager call`, async () => {
      const { sql, recording, error } = await run(c, c.statements.slice(0, requestsRead(c)));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => c.merchant_migration)) {
    it(`hands ${c.name} back after reading the user`, async () => {
      const { sql, error } = await run(c, c.statements.slice(0, 1));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
    });
  }

  for (const c of golden.cases.filter((c) => c.name === UNPARSEABLE)) {
    it(`hands ${c.name} back after reading the requests`, async () => {
      const { sql, error } = await run(c, c.statements.slice(0, requestsRead(c)));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, error } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  for (const c of golden.cases.filter((c) => c.name === PAYPAL_ACCOUNT)) {
    // Rails finishes this one on the Stripe account check; Node cannot tell what the PayPal account's details hold.
    it(`hands ${c.name} back after looking for the PayPal account`, async () => {
      const { sql, error } = await run(c, c.statements.slice(0, 2));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { error } = await run(golden.cases[0]!, [], []);

    expect(error).not.toBeNull();
  });
});
