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
import { markFailedBang, type PaymentRecord } from "./payment.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import {
  assertPayoutShape,
  claimPayoutGroups,
  createPaymentBangFor,
  createPaymentsBang,
  markBalancesProcessing,
  PAYOUT_TYPE_INSTANT,
  PAYOUT_TYPE_STANDARD,
  type PreparePayment,
} from "./payouts.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { NotPortedError, findUserBang, resetUserCollaborators, setUserCollaborators } from "./user.ts";

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

// The statements up to the last claim of a balance, closed with the COMMIT the seller lock's transaction ends with.
const claimPrefix = (c: Case): Statement[] => {
  const last = c.statements
    .map((s) => s.sql)
    .findLastIndex((sql) => sql.startsWith("UPDATE `balances` SET `balances`.`state` = 'processing'"));
  return [...c.statements.slice(0, last + 1), { sql: "COMMIT", result: { affected: 0 } }];
};

describe("mark_balances_processing claim", () => {
  const claim = (type: string) => async () =>
    markBalancesProcessing(await seller(), PAYOUT_DATE, type as never, { now });
  const CLAIMS: Record<string, [Action, number[]]> = {
    "one payable Stripe-held balance becomes one processing payment": [claim(PAYOUT_TYPE_STANDARD), [1]],
    "two balances share one payment": [claim(PAYOUT_TYPE_STANDARD), [1, 2]],
    "a balance dated after the payout date is not claimed": [claim(PAYOUT_TYPE_STANDARD), [1]],
    "an instant payout records its payout type": [claim(PAYOUT_TYPE_INSTANT), [1]],
    "Gumroad-held balances join the seller's own group": [claim(PAYOUT_TYPE_STANDARD), [2, 1]],
  };
  for (const [name, [action, ids]] of Object.entries(CLAIMS)) {
    it(name, async () => {
      const c = byName(name);
      const { sql, error, result } = await run(c, claimPrefix(c), action);
      expect(sql.log).toEqual(sql.expected);
      expect(error).toBeNull();
      expect(
        (result as { balances: { get(name: string): unknown }[] }).balances.map((b) => Number(b.get("id"))),
      ).toEqual(ids);
    });
  }
});

describe("a withheld ledger", () => {
  const HOLDS = [
    "a negative ledger is withheld and noted once",
    "a negative ledger already noted adds no second note",
    "a group the claim leaves non-positive is released",
  ];
  for (const name of HOLDS) {
    it(name, async () => {
      const c = byName(name);
      const { sql, error, result } = await run(c, c.statements, async () =>
        claimPayoutGroups(await seller(), PAYOUT_DATE, { now }),
      );
      expect(sql.log).toEqual(sql.expected);
      expect(error).toBeNull();
      expect(result).toEqual([]);
    });
  }
});

describe("the payments of a payout", () => {
  type Behaviour = "none" | "raise" | "fail";
  // The stub the Ruby cases install for `prepare_payment_and_set_amount`: it records its arguments and may raise or fail the payment.
  const prepareStub =
    (calls: unknown[], behaviour: Behaviour): PreparePayment =>
    async (payment, balances, account, currency) => {
      calls.push({
        payment_id: Number(payment.get("id")),
        balance_ids: balances.map((balance) => Number(balance.get("id"))),
        merchant_account_id: account === null ? null : Number(account.id),
        payout_currency: currency,
      });
      if (behaviour === "raise") throw new Error("stripe is unreachable");
      if (behaviour === "fail") {
        await markFailedBang(payment, "cannot_pay", { now });
        return ["failed"];
      }
      return [];
    };
  const CASES: Record<string, { behaviour: Behaviour; type?: string; single?: boolean }> = {
    "one payable Stripe-held balance becomes one processing payment": { behaviour: "none" },
    "two balances share one payment": { behaviour: "none" },
    "a balance dated after the payout date is not claimed": { behaviour: "none" },
    "an instant payout records its payout type": { behaviour: "none", type: PAYOUT_TYPE_INSTANT },
    "Gumroad-held balances join the seller's own group": { behaviour: "none" },
    "a processor error fails the payment as processor_unavailable": { behaviour: "raise" },
    "a payment the processor already failed is not marked processing": { behaviour: "fail" },
    "create_payment returns the single payment": { behaviour: "none", single: true },
  };
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, async () => {
      const c = byName(name);
      const calls: unknown[] = [];
      let payments: [PaymentRecord, string[]][] = [];
      const { sql, error } = await run(c, c.statements, async () => {
        const user = await seller();
        const input = { payoutType: spec.type as never, now, prepare: prepareStub(calls, spec.behaviour) };
        if (spec.single) {
          const single = await createPaymentBangFor(PAYOUT_DATE, user, input);
          payments = single ? [single] : [];
        } else payments = await createPaymentsBang(PAYOUT_DATE, user, input);
      });
      expect(sql.log).toEqual(sql.expected);
      expect(error).toBeNull();
      expect(calls).toEqual(c.prepare_calls);
      expect(payments.map(([payment]) => payment.get("state"))).toEqual([
        spec.behaviour === "none" ? "processing" : "failed",
      ]);
    });
  }
});

describe("shapes refused before the first write", () => {
  // The first case with one of its answers changed: the statements Node sends are judged, not compared with Ruby's.
  const patched = (patch: (statement: Statement, index: number) => void): Statement[] => {
    const copy = structuredClone(byName("one payable Stripe-held balance becomes one processing payment").statements);
    copy.forEach(patch);
    return copy;
  };
  const setField = (statement: Statement, field: string, value: unknown) => {
    const index = statement.result?.fields?.indexOf(field) ?? -1;
    if (index >= 0) for (const row of statement.result!.rows!) row[index] = value as never;
  };
  const table = (statement: Statement) => /FROM `(\w+)`/u.exec(statement.sql)?.[1];
  const refused = async (statements: Statement[], input: Partial<Parameters<typeof createPaymentsBang>[2]> = {}) => {
    const c = byName("one payable Stripe-held balance becomes one processing payment");
    const prepared: unknown[] = [];
    const { sql, error } = await run(c, statements, async () =>
      createPaymentsBang(PAYOUT_DATE, await seller(), {
        now,
        prepare: (...args) => Promise.resolve((prepared.push(args), [])),
        ...input,
      }),
    );
    expect(error).toBeInstanceOf(NotPortedError);
    // Nothing was written and Stripe was never reached: only reads, the seller lock and the balances' lock were sent.
    expect(sql.log.filter((statement) => /^(INSERT|UPDATE|DELETE)/u.test(statement))).toEqual([]);
    expect(prepared).toEqual([]);
    return error as NotPortedError;
  };

  it("a balance in a currency its Stripe account does not hold", async () => {
    const error = await refused(
      patched((s) => {
        if (table(s) === "balances") setField(s, "holding_currency", "eur");
      }),
    );
    expect(error.message).toMatch(/currency its Stripe account does not hold/u);
  });

  it("a balance held on a retired Stripe account", async () => {
    const error = await refused(
      patched((s) => {
        if (table(s) === "merchant_accounts" && s.sql.includes("`id` = 3"))
          setField(s, "charge_processor_alive_at", null);
      }),
    );
    expect(error.message).toMatch(/retired Stripe account/u);
  });

  it("a balance on an account retired by adoption", async () => {
    const error = await refused(
      patched((s) => {
        if (table(s) === "merchant_accounts" && s.sql.includes("`id` = 3"))
          setField(s, "json_data", '{"retired_by_adoption_at":"2025-10-01T00:00:00Z"}');
      }),
    );
    expect(error.message).toMatch(/retired Stripe account/u);
  });

  it("a seller paused by the system, who may be under the chargeback-rate reserve", async () => {
    const error = await refused(
      patched((s) => {
        if (table(s) === "users") {
          setField(s, "flags", 1 << 19);
          setField(s, "json_data", '{"payouts_paused_by":"system"}');
        }
      }),
    );
    expect(error.message).toMatch(/chargeback-rate reserve/u);
  });

  it("a retried payout", async () => {
    const error = await refused(byName("one payable Stripe-held balance becomes one processing payment").statements, {
      retrying: true,
    });
    expect(error.message).toMatch(/retried payout/u);
  });

  it("a seller with Stripe Connect routing", async () => {
    const c = byName("one payable Stripe-held balance becomes one processing payment");
    const sql = sqlReplay(c.statements);
    setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(true) });
    let error: unknown = null;
    try {
      await createPaymentsBang(PAYOUT_DATE, await seller(), { now, prepare: () => Promise.resolve([]) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotPortedError);
    expect(sql.log.filter((statement) => /^(INSERT|UPDATE|DELETE)/u.test(statement))).toEqual([]);
  });

  it("a legal entity outside the United States", async () => {
    const error = await refused(
      patched((s) => {
        if (table(s) === "user_compliance_info") {
          s.result = { fields: ["id", "country", "is_business"], rows: [[1, "Canada", false]] };
        }
      }),
    );
    expect(error.message).toMatch(/country other than the United States/u);
  });

  it("a single payout that would need several, and a group that sums to nothing", () => {
    const held = (id: number, accountId: number, amount: number, holder = "stripe") =>
      ({
        holder,
        account: {},
        balance: {
          get: (name: string) =>
            ({ id, merchant_account_id: accountId, holding_currency: "usd", amount_cents: amount })[name],
        },
      }) as never;
    const account = { id: 3, currency: "usd" } as never;
    expect(() => assertPayoutShape([held(1, 3, 100), held(2, 4, 100)], account, true)).toThrow(
      /MultiplePayoutGroupsError/u,
    );
    expect(() => assertPayoutShape([held(1, 3, 100), held(2, 4, 100)], account, false)).not.toThrow();
    expect(() => assertPayoutShape([held(1, 3, 100), held(2, 4, 0)], account, false)).toThrow(/sums to nothing/u);
    // A negative ledger is withheld, not refused.
    expect(() => assertPayoutShape([held(1, 3, 100), held(2, 4, -500)], account, true)).not.toThrow();
  });
});
