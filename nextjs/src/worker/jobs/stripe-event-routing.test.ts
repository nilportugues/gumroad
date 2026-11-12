// Replays stripe-event-routing.golden.json (scripts/golden/stripe-event-routing.rb): HandleStripeEventWorker run by the real app as a
// Sidekiq job for the events that end without a ledger write or a Stripe call. Node sends the statements Rails sent, raises the
// errors Rails raised and pushes nothing; the cases that would reach the ledger or Stripe are handed back before any write.
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

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
import { handleStripeEventWorkerWith } from "./payment-processor-jobs.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  http?: unknown[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stripe-event-routing.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const handleStripeEventWorker = handleStripeEventWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

beforeAll(() => {
  // config/initializers: the golden's ObfuscateIds uses the test cipher key (.env.test).
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "1";
});

async function run(args: JsonValue[]): Promise<{ error: Error | null; snapshot: RedisSnapshot }> {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  try {
    await asSidekiqJob(() => handleStripeEventWorker(args, contextFor(runtime)), golden.now);
    return { error: null, snapshot: recording.snapshot() };
  } catch (e) {
    return { error: e as Error, snapshot: recording.snapshot() };
  }
}

describe("HandleStripeEventWorker for events that end without the ledger or Stripe", () => {
  it("records no Stripe request in any case", () => {
    expect(golden.cases.flatMap((c) => c.http ?? [])).toEqual([]);
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { error, snapshot } = await run(c.args);
      if (c.error?.class === "ActiveRecord::RecordNotUnique") expect(error).not.toBeNull();
      else expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(snapshot).toEqual(c.redis);
    });
  }
});

const find = (name: string) => golden.cases.find((c) => c.name === name)!;

// The answer of a recorded lookup with some of its columns replaced.
function withColumns(statement: Statement, columns: Record<string, unknown>): Statement {
  const result = statement.result as { fields: string[]; rows: unknown[][] };
  const rows = result.rows.map((row) =>
    row.map((value, i) => (Object.hasOwn(columns, result.fields[i] ?? "") ? columns[result.fields[i]!] : value)),
  );
  return { ...statement, result: { ...result, rows } as Statement["result"] };
}

describe("events Node leaves to Rails", () => {
  const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id: "evt_1", type, created: 1_762_000_000, data: { object }, ...extra }) as JsonValue;
  const charge = { object: "charge", id: "ch_1", metadata: {} };

  it.each([
    ["a charge event", event("charge.captured", charge)],
    [
      "a charge.succeeded of a charge with a blank Twitter username",
      event("charge.succeeded", { ...charge, metadata: { twitter_username: " " } }),
    ],
    ["a charge.refund.updated event", event("charge.refund.updated", { object: "refund", id: "re_1" })],
    ["a refund.updated event", event("refund.updated", { object: "refund", id: "re_1" })],
    [
      "a refund.failed event of a connected account",
      event("refund.failed", { object: "refund", id: "re_1" }, { account: "acct_1" }),
    ],
    ["a dispute event", event("charge.dispute.created", { object: "dispute", id: "dp_1", charge: "ch_1" })],
    [
      "a dispute.closed event that is not a refund closure",
      event("charge.dispute.closed", { object: "dispute", id: "dp_1", charge: "ch_1", status: "lost" }),
    ],
    [
      "a payment_intent.payment_failed event",
      event("payment_intent.payment_failed", { object: "payment_intent", id: "pi_1" }),
    ],
    [
      "a radar event of a supported type",
      event("radar.early_fraud_warning.created", {
        object: "radar.early_fraud_warning",
        id: "issfr_1",
        charge: "ch_1",
      }),
    ],
    [
      "a payout.paid event of a connected account",
      event("payout.paid", { object: "payout", id: "po_1" }, { account: "acct_1" }),
    ],
    [
      "a payout.failed event of a connected account",
      event("payout.failed", { object: "payout", id: "po_1" }, { account: "acct_1" }),
    ],
    [
      "a payout.canceled event of a connected account",
      event("payout.canceled", { object: "payout", id: "po_1" }, { account: "acct_1" }),
    ],
    [
      "a connected account.updated variant",
      event("account.updated.v2", { object: "account", id: "acct_1" }, { account: "acct_1" }),
    ],
    ["a charge event without a data object", { id: "evt_1", type: "charge.captured", created: 1 } as JsonValue],
    [
      "a dispute event whose id is an array",
      { id: [1], type: "charge.dispute.created", created: 1, data: { object: { object: "charge" } } } as JsonValue,
    ],
    ["a charge.succeeded without metadata", event("charge.succeeded", { object: "charge", id: "ch_1" })],
    [
      "a payment_intent whose metadata is missing",
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_1" }),
    ],
    [
      "a payment_intent whose latest_charge is expanded",
      event("payment_intent.succeeded", {
        object: "payment_intent",
        id: "pi_1",
        metadata: {},
        latest_charge: { id: "ch_1" },
      }),
    ],
    [
      "a payment_intent whose id is not a String",
      event("payment_intent.processing", { object: "payment_intent", id: 7, metadata: {} }),
    ],
    [
      "a capital transaction without details",
      event("capital.financing_transaction.created", { type: "payment", account: "acct_1" }),
    ],
    [
      "a capital transaction whose account is not a String",
      event("capital.financing_transaction.created", { type: "payment", account: null, details: { currency: "usd" } }),
    ],
    ["a checkout session without a data object", { id: "evt_1", type: "checkout.session.completed" } as JsonValue],
    [
      "a checkout session whose metadata is a string",
      event("checkout.session.completed", { object: "checkout.session", metadata: "x" }),
    ],
    [
      "a checkout session whose offer id is a Hash",
      event("checkout.session.completed", { object: "checkout.session", metadata: { seller_plan_offer_id: {} } }),
    ],
    [
      "a checkout session whose offer id is a fraction",
      event("checkout.session.completed", { object: "checkout.session", metadata: { seller_plan_offer_id: 1.5 } }),
    ],
    [
      "a checkout session whose offer id is out of range",
      event("checkout.session.completed", {
        object: "checkout.session",
        metadata: { seller_plan_offer_id: "99999999999999999999" },
      }),
    ],
  ])("%s is handed back before any statement", async (_name, params) => {
    const sql = sqlReplay([]);
    const { error, snapshot } = await run([params]);
    if (error === null) throw new Error("expected a hand-back");
    expect(error.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(snapshot).toEqual({});
  });

  it("a payment_intent of a client-confirmed charge no event recorded is handed back after the reads", async () => {
    const c = find("payment_intent.succeeded of a client confirmed charge already processed is ignored");
    const [chargeLookup, processed] = c.statements;
    const sql = sqlReplay([chargeLookup!, { ...processed!, result: { fields: ["one"], rows: [] } }]);
    const { error, snapshot } = await run(c.args);
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(snapshot).toEqual({});
  });

  it("a capital financing transaction of a managed account with a seller is handed back after the lookup", async () => {
    const c = find("capital financing transaction of a Connect account is ignored");
    const [lookup] = c.statements;
    const sql = sqlReplay([withColumns(lookup!, { json_data: '{"meta":{"stripe_connect":"false"}}' })]);
    const { error, snapshot } = await run(c.args);
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(snapshot).toEqual({});
  });
});
