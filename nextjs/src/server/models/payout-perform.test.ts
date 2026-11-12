// Replays payouts-perform.golden.json (scripts/golden/payouts-perform.rb): the real StripePayoutProcessor.process_payments, run by Ruby
// against a scratch database with Stripe answered by WebMock. Node must send the statements and Stripe calls Rails sent (with the
// same number of statements before each call), enqueue the same mail and leave the payment as Rails did.
import { beforeAll, describe, expect, it } from "vitest";

import {
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  withoutJobIds,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { jsonDataForAttr } from "./concerns/json-data.ts";
import { findPaymentBang, type PaymentRecord } from "./payment.ts";
import { processPaymentsBang } from "./payout-perform.ts";

type PerformCase = GoldenCase & { payment: Record<string, unknown> };
const golden = loadGolden(new URL("./__fixtures__/payouts-perform.golden.json", import.meta.url)) as Golden & {
  cases: PerformCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
let payment: PaymentRecord | null = null;

const attributes = (record: PaymentRecord) => {
  const number = (value: unknown) => (value == null ? null : Number(value));
  return {
    state: record.get("state"),
    amount_cents: number(record.get("amount_cents")),
    currency: record.get("currency"),
    stripe_connect_account_id: record.get("stripe_connect_account_id"),
    stripe_internal_transfer_id: record.get("stripe_internal_transfer_id") ?? null,
    stripe_transfer_id: record.get("stripe_transfer_id") ?? null,
    failure_reason: record.get("failure_reason") ?? null,
    bank_account_id: number(record.get("bank_account_id")),
    error_message: jsonDataForAttr(record, "error_message"),
    arrival_date: jsonDataForAttr(record, "arrival_date"),
    gumroad_fee_cents: jsonDataForAttr(record, "gumroad_fee_cents"),
  };
};

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

describe("process_payments", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      payment = null;
      const replay = await replayCase(golden, c, async () => {
        payment = await findPaymentBang(7);
        await processPaymentsBang([payment], { now });
      });
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(attributes(payment!)).toEqual(c.payment);
      expect(replay.cache).toEqual(c.cache);
      expect(replay.redis).toEqual(withoutJobIds(c.redis));
    });
  }
});
