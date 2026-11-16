// Replays payouts-instant-supported.golden.json (scripts/golden/payouts-instant-supported.rb): the real User#instant_payouts_supported?, run by
// Ruby against a scratch database with Stripe answered by WebMock. Node must send the statements and the one Stripe read Rails sent, with the
// same number of statements before it, and reach the same answer.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { instantPayoutsSupported } from "./instant-payouts-supported.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { findUserBang, NotPortedError } from "./user.ts";

type SupportedCase = GoldenCase & { supported: boolean | null };
const golden = loadGolden(
  new URL("./__fixtures__/payouts-instant-supported.golden.json", import.meta.url),
) as Golden & {
  cases: SupportedCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
let supported: boolean | null = null;

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

beforeEach(() => {
  supported = null;
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
});

afterEach(() => resetPayoutReadCollaborators());

// The Ruby case starts with `User.find(5)` outside the method.
const action = async () => {
  supported = await instantPayoutsSupported(await findUserBang(5), { now });
};

describe("User#instant_payouts_supported?", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const replay = await replayCase(golden, c, action);
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(supported).toEqual(c.supported);
      expect(replay.cache).toEqual(c.cache);
    });
  }

  // payout-reads.ts refuses these before the Stripe read, from rows already read.
  it("refuses a Stripe-held balance in a currency its account does not hold before the Stripe read", async () => {
    const c = structuredClone(
      golden.cases.find((candidate) => candidate.name.startsWith("a Stripe-held balance on the"))!,
    );
    for (const statement of c.statements) {
      const index = statement.result?.fields?.indexOf("holding_currency") ?? -1;
      if (index >= 0) for (const row of statement.result!.rows!) row[index] = "eur";
    }
    const replay = await replayCase(golden, c, action);
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls).toEqual([]);
  });

  it("refuses a seller with Connect routing before the Stripe read", async () => {
    setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(true) });
    const replay = await replayCase(golden, golden.cases[0]!, action);
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls).toEqual([]);
  });
});
