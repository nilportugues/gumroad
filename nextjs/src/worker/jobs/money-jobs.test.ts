// Replays money-jobs.golden.json (scripts/golden/money-jobs.rb): the real
// HandleStripeAutodebitForNegativeBalance and RecoverAusBacktaxFromStripeAccountJob, with Credit,
// BalanceTransaction, Balance, BacktaxCollection and CurrencyHelper, run as Sidekiq runs jobs
// against MySQL, with Stripe and OpenExchangeRates answered by a capture server. Node must send the
// same statements, Stripe and OpenExchangeRates requests and Redis writes, given the same answers.
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setCurrencyDepsForTesting } from "../../server/models/concerns/currency-helper.ts";
import { setSellerProfileCacheForTesting } from "../../server/models/seller-profile.ts";
import { resetUserCollaborators, setUserCollaborators } from "../../server/models/user.ts";
import { StripeClient, setStripeClientForTesting, type TransportRequest } from "../../server/stripe/client.ts";
import { stripeConfigFromEnv } from "../../server/stripe/config.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { handleStripeAutodebitForNegativeBalanceWith } from "./handle-stripe-autodebit-job.ts";
import { recoverAusBacktaxFromStripeAccountJobWith } from "./recover-aus-backtax-from-stripe-account-job.ts";
import { updateSellerRefundEligibilityJobWith } from "./update-seller-refund-eligibility-job.ts";

type Request = { method: string; path: string; query: string | null; body: string | null; stripe_account: string | null };
type MoneyCase = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  cache: [string, string][];
  stripe: { responses: [number, Record<string, string>, string][]; requests: Request[] };
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/money-jobs.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  platform_account_id: string;
  cases: MoneyCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
const HANDLERS = {
  HandleStripeAutodebitForNegativeBalance: handleStripeAutodebitForNegativeBalanceWith,
  RecoverAusBacktaxFromStripeAccountJob: recoverAusBacktaxFromStripeAccountJobWith,
  UpdateSellerRefundEligibilityJob: updateSellerRefundEligibilityJobWith,
};

// The OpenExchangeRates request shares the script with Stripe's: the third response of a case that
// converts a currency whose rate is not cached.
const RATES_PATH = "/api/latest.json";

function harness(c: MoneyCase) {
  const requests: Request[] = [];
  const script = [...c.stripe.responses];
  const stripe = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test", maxNetworkRetries: 0 },
    sleep: async () => {},
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      requests.push({
        method: request.method.toUpperCase(),
        path: path!,
        query: query.length ? query.join("?") : null,
        body: request.body ?? null,
        stripe_account: request.headers["Stripe-Account"] ?? null,
      });
      const [status, headers, body] = script.shift() ?? [500, {}, "no scripted response"];
      return { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body };
    },
  });
  const store = new Map(
    Object.entries(c.redis_before ?? {})
      .filter(([, entry]) => entry.type === "string")
      .map(([key, entry]) => [key, entry.value as string]),
  );
  const redis = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: string) => (store.set(key, value), "OK" as const) };
  setCurrencyDepsForTesting({
    redis: () => redis as never,
    readSource: async () => {
      requests.push({ method: "GET", path: RATES_PATH, query: "app_id=golden", body: null, stripe_account: null });
      const [status, , body] = script.shift() ?? [500, {}, "no scripted response"];
      if (status >= 400) throw new Error(`${status}`);
      return body;
    },
  });
  return { stripe, requests, store };
}

// Ruby's Net::HTTP sends `?` with an empty query on a GET.
const normalize = (r: Request) => ({ ...r, query: r.query === "" ? null : r.query, body: r.body === "" ? null : r.body });
const isRate = (key: string) => key.startsWith("currencies:");
// The class's own name: Ruby's namespace (Stripe::, ActiveRecord::) is the port's module.
const rubyClassName = (error: unknown) => ((error as { rubyClass?: string }).rubyClass ?? (error as Error).name).split("::").at(-1);

beforeAll(() => {
  process.env.STRIPE_PLATFORM_ACCOUNT_ID = golden.platform_account_id;
});

afterEach(() => {
  setStripeClientForTesting(undefined);
  setCurrencyDepsForTesting(undefined);
  resetUserCollaborators();
});

describe("money jobs", () => {
  for (const c of golden.cases) {
    it(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      const { stripe, requests, store } = harness(c);
      setStripeClientForTesting(stripe);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const cache: [string, string][] = [];
      setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
      setUserCollaborators({ now });
      let error: unknown = null;
      try {
        const handler = HANDLERS[c.job as keyof typeof HANDLERS]({ now });
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(requests.map(normalize)).toEqual(c.stripe.requests.map(normalize));
      expect(error === null ? null : { class: rubyClassName(error), message: (error as Error).message }).toEqual(
        c.error === null ? null : { class: c.error.class.split("::").at(-1), message: c.error.message },
      );
      expect(cache).toEqual(c.cache);
      expect(recording.snapshot()).toEqual(Object.fromEntries(Object.entries(c.redis).filter(([key]) => !isRate(key))));
      expect(Object.fromEntries([...store].filter(([key]) => isRate(key)))).toEqual(
        Object.fromEntries(Object.entries(c.redis).filter(([key]) => isRate(key)).map(([key, entry]) => [key, entry.value])),
      );
    });
  }

  // Cases Node does not run are handed back before the job's first write. There is no Ruby run to
  // compare with: the recorded case is replayed with the merchant account answered differently.
  describe("handing back to Rails", () => {
    const withMerchantAccount = (name: string, change: Record<string, unknown>, prefix: RegExp) => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const statements = structuredClone(c.statements);
      for (const statement of statements) {
        if (!prefix.test(statement.sql) || !statement.result?.fields) continue;
        for (const [field, value] of Object.entries(change)) statement.result.rows![0]![statement.result.fields.indexOf(field)] = value as never;
      }
      return { ...c, statements };
    };
    const run = async (c: MoneyCase) => {
      setSellerProfileCacheForTesting({ delete: async () => undefined });
      setUserCollaborators({ now });
      const sql = sqlReplay(c.statements);
      const { stripe, requests } = harness(c);
      setStripeClientForTesting(stripe);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const handler = HANDLERS[c.job as keyof typeof HANDLERS]({ now });
      const error = await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now).then(
        () => null,
        (e: unknown) => e as Error,
      );
      return { error, log: sql.log, requests };
    };
    const MERCHANT_ACCOUNT_READ = /^SELECT `merchant_accounts`/u;

    it("a debit on a merchant account of another processor", async () => {
      const { error, log } = await run(withMerchantAccount("a negative payout becomes a credit and a new balance", { charge_processor_id: "paypal" }, MERCHANT_ACCOUNT_READ));
      expect(error?.name).toBe("HandBackToRuby");
      expect(log.filter((sql) => /^(BEGIN|INSERT|UPDATE)/u.test(sql))).toEqual([]);
    });

    it("a debit on a merchant account without a currency", async () => {
      const { error, log } = await run(withMerchantAccount("a negative payout becomes a credit and a new balance", { currency: null }, MERCHANT_ACCOUNT_READ));
      expect(error?.name).toBe("HandBackToRuby");
      expect(log.filter((sql) => /^(BEGIN|INSERT|UPDATE)/u.test(sql))).toEqual([]);
    });

    it("a seller on probation whose balance has recovered, before the refunds flag is written", async () => {
      const c = golden.cases.find((candidate) => candidate.name === "a seller on probation below the recovery threshold")!;
      const statements = structuredClone(c.statements);
      statements.find((statement) => statement.sql.startsWith("SELECT SUM"))!.result!.rows![0]![0] = { $decimal: "10000.0" } as never;
      const { error, log } = await run({ ...c, statements });
      expect(error?.name).toBe("HandBackToRuby");
      expect(log.filter((sql) => /^(BEGIN|INSERT|UPDATE)/u.test(sql))).toEqual([]);
    });

    it("a backtax on a merchant account of another processor, before any Stripe write", async () => {
      const { error, log, requests } = await run(withMerchantAccount("a US account transfers the amount owed", { charge_processor_id: "paypal" }, MERCHANT_ACCOUNT_READ));
      expect(error?.name).toBe("HandBackToRuby");
      expect(log.filter((sql) => /^(BEGIN|INSERT|UPDATE)/u.test(sql))).toEqual([]);
      expect(requests).toEqual([]);
    });
  });
});
