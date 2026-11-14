// Replays payment-state-machine.golden.json (scripts/golden/payment-state-machine.rb): the real Payment and Balance state machines
// and Credit.create_for_returned_payment_difference!, run by the Ruby models against a scratch database. Node must send the
// statements Rails sent, given the same answers, and enqueue the same mail jobs.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../search/__fixtures__/job-harness.ts";

import { BankAccountDeletable, BankAccounts } from "./bank-account.ts";
import { Balances, fireBalanceEventBang, type BalanceEvent } from "./balance.ts";
import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { createForReturnedPaymentDifferenceBang } from "./credit-creation.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "./link.ts";
import { MerchantAccounts } from "./merchant-account.ts";
import { findPaymentBang, markFailedBang, markProcessingBang, paymentUser } from "./payment.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { resetUserCollaborators, setUserCollaborators } from "./user.ts";

type Case = {
  name: string;
  statements: Statement[];
  error: { class: string; message: string } | null;
  redis: Record<string, { type: string; value: unknown }>;
  cache: [string, string][];
  es?: { method: string; path: string; query: string | null; body: string | null }[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/payment-state-machine.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

const fail = (reason: string | null) => async () => markFailedBang(await findPaymentBang(7), reason, { now });
const balanceEvent = (event: BalanceEvent) => async () => {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "id")} = 1 LIMIT 1`,
  );
  return fireBalanceEventBang(Balances.load(castRow("Balance", row!)), event, { now });
};
const returnedDifference = (differenceAmountCents: number) => async () => {
  const payment = await findPaymentBang(7);
  const user = (await paymentUser(payment))!;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} = 3 LIMIT 1`,
  );
  await createForReturnedPaymentDifferenceBang(
    {
      user,
      merchantAccount: MerchantAccounts.load(castRow("MerchantAccount", row!)),
      returnedPayment: payment,
      differenceAmountCents,
    },
    { now },
  );
};

const deleteBankAccount = async () => {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`bank_accounts`.*")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "id")} = 11 LIMIT 1`,
  );
  await BankAccountDeletable.markDeletedBang(BankAccounts.load(castRow("BankAccount", row!)), { validate: false, now });
};

const ACTIONS: Record<string, () => Promise<unknown>> = {
  "mark_processing! moves a creating payment to processing": async () =>
    markProcessingBang(await findPaymentBang(7), { now }),
  "mark_processing! from processing is not a transition": async () =>
    markProcessingBang(await findPaymentBang(7), { now }),
  "mark_failed! with a transient reason returns the balances to unpaid and comments nothing":
    fail("processor_rate_limited"),
  "mark_failed! with no reason": fail(null),
  "mark_failed! from creating skips the processing callbacks": fail("bank_account_not_found_at_stripe"),
  "mark_failed! with a reason that has a solution adds a seller-visible payout note": fail(
    "bank_account_not_found_at_stripe",
  ),
  "mark_failed! for an amount below the Stripe minimum": fail("below_stripe_payout_minimum"),
  "mark_failed! for destination_currency_mismatch": fail("destination_currency_mismatch"),
  "mark_failed! for stripe_intervention_required": fail("stripe_intervention_required"),
  "mark_failed! cannot_pay mails the seller once and records the period": fail("cannot_pay"),
  "mark_failed! cannot_pay does not mail twice for the same period": fail("cannot_pay"),
  "mark_failed! debit_card_limit mails the seller": fail("debit_card_limit"),
  "mark_failed! with an unaccounted-money reason": fail("payout_outcome_unknown"),
  "the third consecutive failed payout to a bank account pauses payouts and comments": fail("account_closed"),
  "a completed payout in between resets the failure count": fail("account_closed"),
  "transient and internal failures do not count toward the pause": fail("account_closed"),
  "an already paused seller is not paused again": fail("account_closed"),
  "a retired-account drain never trips the pause": fail("account_closed"),
  "failures counted by the Stripe payout destination when the payment has no bank account": fail("account_closed"),
  "a payment with no bank account and no destination is not counted": fail("account_closed"),
  "balance mark_unpaid! from processing": balanceEvent("mark_unpaid"),
  "balance mark_processing! then mark_paid!": async () => {
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "id")} = 1 LIMIT 1`,
    );
    const balance = Balances.load(castRow("Balance", row!));
    await fireBalanceEventBang(balance, "mark_processing", { now });
    await fireBalanceEventBang(balance, "mark_paid", { now });
  },
  "balance mark_paid! from unpaid is not a transition": balanceEvent("mark_paid"),
  "BankAccount#mark_deleted! enqueues the recommendability refresh when it was the last payout method": deleteBankAccount,
  "BankAccount#mark_deleted! leaves recommendability alone while the seller has a PayPal address": deleteBankAccount,
  "Credit.create_for_returned_payment_difference! writes the credit, its balance transaction and the balance":
    returnedDifference(-137),
  "Credit.create_for_returned_payment_difference! adds to the day's existing balance": returnedDifference(250),
};

// ActiveJob mints a random job_id; everything else in the enqueued item is compared as recorded.
const withoutJobIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replace(/\\"job_id\\":\\"[0-9a-f-]{36}\\"/gu, '\\"job_id\\":\\"<uuid>\\"'));

afterEach(() => {
  resetUserCollaborators();
  resetLinkCollaborators();
});

describe("Payment state machine", () => {
  it("has a Node action for every golden case", () => {
    expect(golden.cases.map((c) => c.name).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  for (const c of golden.cases) {
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
      process.env.MOBILE_API_OAUTH_APPLICATION_UID = "test-mobile-api-oauth-app-uid";
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
      expect(es.requests).toEqual(c.es ?? []);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis as JsonValue));
    });
  }
});
