// Replays payouts-reversal.golden.json (scripts/golden/payouts-reversal.rb): the real StripePayoutProcessor reversal of an internal
// transfer, run by Ruby against a scratch database with Stripe answered by WebMock. Node must send the statements and the Stripe calls
// Rails sent, with the same number of statements before each call.
import { beforeAll, describe, expect, it } from "vitest";

import { goldenCalls, goldenStatementsBeforeCall, loadGolden, replayCase } from "./__fixtures__/payout-golden.ts";
import { reverseInternalTransferOrHoldPayoutsBang } from "./payment-hold.ts";
import { findPaymentBang } from "./payment.ts";

const golden = loadGolden(new URL("./__fixtures__/payouts-reversal.golden.json", import.meta.url));
const now = () => new Date(Math.round(golden.now * 1000));

const UNKNOWN = "payout_outcome_unknown";
const UNAVAILABLE = "processor_unavailable";
const reverse =
  (reason: string, reraise = false) =>
  async () =>
    reverseInternalTransferOrHoldPayoutsBang(await findPaymentBang(7), reason, { now, reraise });

const ACTIONS: Record<string, () => Promise<unknown>> = {
  "a reversal with no difference writes nothing": reverse(UNAVAILABLE),
  "a reversal short of the transfer is covered by a credit": reverse(UNAVAILABLE),
  "a reversal that returns more than the transfer credits the seller": reverse(UNAVAILABLE),
  "a transfer that is already reversed is not reversed again": reverse(UNAVAILABLE),
  "a difference credit already recorded ends the reversal after the transfer call": reverse(UNAVAILABLE),
  "an unknown payout outcome is reversed and then held": reverse(UNKNOWN),
  "a reversal Stripe refuses stamps the payment and holds the seller": reverse(UNAVAILABLE),
  "a reversal Stripe refuses raises when the caller asks to reraise": reverse(UNAVAILABLE, true),
  "a refused reversal keeps the unknown outcome reason": reverse(UNKNOWN),
  "a destination charge without a refund fails the reversal after the transfer was reversed": reverse(UNAVAILABLE),
  "a sibling payout awaiting its bank payout does not defer a United States seller": reverse(UNAVAILABLE),
  "a payment with no sibling reverses at once": reverse(UNAVAILABLE),
};

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

describe("reversal of a failed payout's internal transfer", () => {
  it("covers every golden case", () => {
    expect(golden.cases.map((c) => c.name).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      const replay = await replayCase(golden, c, ACTIONS[c.name]!);
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(replay.cache).toEqual(c.cache);
    });
  }
});
