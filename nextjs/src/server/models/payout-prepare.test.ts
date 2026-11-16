// Replays payouts-prepare.golden.json (scripts/golden/payouts-prepare.rb): the real StripePayoutProcessor.prepare_payment_and_set_amount,
// run by Ruby against a scratch database with Stripe answered by WebMock. Node must send the statements and Stripe calls Rails sent
// (with the same number of statements before each call) and leave the payment as Rails did.
import { Prisma } from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InvalidRequestError } from "../stripe/errors.ts";

import {
  withoutJobIds,
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { Balances } from "./balance.ts";
import { jsonDataForAttr } from "./concerns/json-data.ts";
import type { MerchantAccountRow } from "./merchant-account.ts";
import { findPaymentBang, setPaymentBalances, type PaymentRecord } from "./payment.ts";
import { stripeInvalidRequestErrorFailureReason } from "./payout-failure-reason.ts";
import { preparePaymentAndSetAmount, setPrepareSleep } from "./payout-prepare.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type PrepareCase = GoldenCase & {
  returned: string[] | null;
  payment: Record<string, unknown>;
  sleeps: number[];
  payout_currency: string | null;
  account: string;
};
const golden = loadGolden(new URL("./__fixtures__/payouts-prepare.golden.json", import.meta.url)) as Golden & {
  cases: PrepareCase[];
  failure_reasons: [string, string | null, string | null][];
};
const now = () => new Date(Math.round(golden.now * 1000));

const slept: number[] = [];
let returned: string[] | null = null;
let payment: PaymentRecord | null = null;

// What the Ruby script runs around the method: the payment, its balances ordered by id, and the group's merchant account.
async function action(c: PrepareCase) {
  payment = await findPaymentBang(7);
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} INNER JOIN ${table("payments_balances")} ON ${column("balances", "id")} = ${column("payments_balances", "balance_id")} WHERE ${column("payments_balances", "payment_id")} = ${7} ORDER BY ${column("balances", "id")} ASC`,
  );
  const balances = rows.map((row) => Balances.load(castRow("Balance", row)));
  setPaymentBalances(payment, balances);
  let merchantAccount: MerchantAccountRow | null = null;
  if (c.account !== "none") {
    [merchantAccount = null] = await selectRows<MerchantAccountRow>(
      Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} = ${3} LIMIT 1`,
    );
  }
  returned = await preparePaymentAndSetAmount(payment, balances, merchantAccount, c.payout_currency, { now });
}

function paymentAttributes(record: PaymentRecord) {
  const number = (value: unknown) => (value == null ? null : Number(value));
  return {
    state: record.get("state"),
    amount_cents: number(record.get("amount_cents")),
    currency: record.get("currency"),
    stripe_connect_account_id: record.get("stripe_connect_account_id"),
    stripe_internal_transfer_id: record.get("stripe_internal_transfer_id") ?? null,
    failure_reason: record.get("failure_reason") ?? null,
    bank_account_id: number(record.get("bank_account_id")),
    error_message: jsonDataForAttr(record, "error_message"),
    retired_account_drain: jsonDataForAttr(record, "retired_account_drain"),
    errors: record.errors.fullMessages(),
  };
}

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

beforeEach(() => {
  slept.length = 0;
  returned = null;
  payment = null;
  setPrepareSleep((seconds) => Promise.resolve(void slept.push(seconds)));
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
});

afterEach(() => resetPayoutReadCollaborators());

describe("prepare_payment_and_set_amount", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const replay = await replayCase(golden, c, () => action(c));
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      // The Ruby message is the gem's; a Node error from the same answer carries the same one.
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(returned).toEqual(c.returned);
      expect(slept).toEqual(c.sleeps);
      expect(paymentAttributes(payment!)).toEqual(c.payment);
      expect(replay.cache).toEqual(c.cache);
      expect(replay.redis).toEqual(withoutJobIds(c.redis));
    });
  }

  // The claim refuses these shapes first; prepare refuses them again because it is the one that moves money.
  it("refuses a destination that is not active before any write or Stripe call", async () => {
    const c = structuredClone(golden.cases[0]!);
    for (const statement of c.statements) {
      const index = statement.result?.fields?.indexOf("charge_processor_alive_at") ?? -1;
      if (index >= 0) for (const row of statement.result!.rows!) row[index] = null;
    }
    const replay = await replayCase(golden, c, () => action(c));
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls).toEqual([]);
    expect(replay.sqlLog.filter((sql) => /^(INSERT|UPDATE|DELETE|BEGIN)/u.test(sql))).toEqual([]);
  });

  it("refuses a balance in a currency its account does not hold before any write or Stripe call", async () => {
    const c = structuredClone(golden.cases[0]!);
    for (const statement of c.statements) {
      const index = statement.result?.fields?.indexOf("holding_currency") ?? -1;
      if (index >= 0) for (const row of statement.result!.rows!) row[index] = "eur";
    }
    const replay = await replayCase(golden, c, () => action({ ...c, payout_currency: "eur" }));
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls).toEqual([]);
    expect(replay.sqlLog.filter((sql) => /^(INSERT|UPDATE|DELETE|BEGIN)/u.test(sql))).toEqual([]);
  });

  it("names the failure reason of each message Ruby classified", () => {
    for (const [message, code, reason] of golden.failure_reasons) {
      const error = new InvalidRequestError(message, null, { httpStatus: 400, code });
      expect(stripeInvalidRequestErrorFailureReason(error), message).toBe(reason);
    }
  });
});
