// Replays alert-on-zero-buyer-currency-wallet-purchases-job.golden.json
// (scripts/golden/alert-on-zero-buyer-currency-wallet-purchases-job.rb): the job run by the real app as a Sidekiq job. Node reads the
// two Flipper features, sends the statements Rails sent, claims and releases the throttle key, and pushes the same
// InternalNotificationWorker alert. The flags and the throttle a case starts from come from its `redis_before`.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { alertOnZeroBuyerCurrencyWalletPurchasesJobWith, type WalletAlertRedis } from "./alert-on-zero-buyer-currency-wallet-purchases-job.ts";

const PUSH_FAILED = "push failed";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-zero-buyer-currency-wallet-purchases-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// The commands the job sends, over the Flipper hashes and the throttle string the case started from; anything else throws.
function mainRedis(before: RedisSnapshot) {
  const claimedFor: number[] = [];
  const store = new Map(Object.entries(before).map(([key, entry]) => [key, { ...entry }]));
  const redis: WalletAlertRedis = {
    hgetall: (key) => Promise.resolve((store.get(key)?.value ?? {}) as Record<string, string>),
    set: (key, value, _expiry, seconds, _mode) => {
      claimedFor.push(seconds);
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, { type: "string", value, expires: true });
      return Promise.resolve("OK");
    },
    del: (key) => Promise.resolve(Number(store.delete(key))),
  };
  return { redis, snapshot: () => Object.fromEntries(store) as RedisSnapshot, claimedFor };
}

async function run(before: RedisSnapshot, statements: Statement[], options: { failPush?: boolean } = {}) {
  const recording = recordingSidekiqRedis();
  const sidekiq = options.failPush
    ? (new Proxy(recording.redis, {
        get: (target, property) =>
          property === "pipeline"
            ? () => {
                const chain = { sadd: () => chain, lpush: () => chain, exec: () => Promise.reject(new Error(PUSH_FAILED)) };
                return chain;
              }
            : Reflect.get(target, property),
      }) as typeof recording.redis)
    : recording.redis;
  const runtime = createJobsRuntime({
    sidekiqRedis: sidekiq,
    bullmqRedis: sidekiq,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const main = mainRedis(before);
  const sql = sqlReplay(statements);
  const handler = alertOnZeroBuyerCurrencyWalletPurchasesJobWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    { redis: () => main.redis },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, main, recording };
}

describe("AlertOnZeroBuyerCurrencyWalletPurchasesJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { error, sql, main, recording } = await run(c.redis_before ?? {}, c.statements, {
        failPush: c.error?.message === PUSH_FAILED,
      });

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect({ ...main.snapshot(), ...recording.snapshot() }).toEqual(c.redis);
    });
  }

  it("holds the throttle for 24 hours", async () => {
    const c = golden.cases.find((c) => c.name === "a counted purchase 25 hours ago")!;
    const { main } = await run(c.redis_before ?? {}, c.statements);

    expect(main.claimedFor).toEqual([86_400]);
  });

  const flag = (name: string, doc: Record<string, string>): RedisSnapshot => ({
    [name]: { type: "hash", value: doc, expires: false },
  });

  for (const [label, first, second] of [
    ["a percentage of time on the first feature", { percentage_of_time: "50" }, { boolean: "true" }],
    ["a fractional percentage of time", { percentage_of_time: "99.5" }, { boolean: "true" }],
    ["an expression gate", { expression: '{"Boolean":true}' }, { boolean: "true" }],
    ["a percentage of time on the second feature", { boolean: "true" }, { percentage_of_time: "10" }],
  ] as [string, Record<string, string>, Record<string, string>][]) {
    it(`hands ${label} back before any write`, async () => {
      const before = { ...flag("payment_element_wallets", first), ...flag("buyer_currency_wallets", second) };
      const { error, sql, main, recording } = await run(before, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(main.snapshot()).toEqual(before);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
