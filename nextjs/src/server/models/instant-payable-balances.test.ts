// Replays payouts-instant-balances.golden.json (scripts/golden/payouts-instant-balances.rb): the real User#instantly_payable_unpaid_balances
// and StripePayoutProcessor.instantly_payable_amount_cents_on_stripe, run by Ruby against a scratch database with Stripe answered by
// WebMock. Node must send the statements (one merchant account read per balance per pass) and the one Stripe read Rails sent.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { instantlyPayableAmountCentsOnStripe, instantlyPayableUnpaidBalances } from "./instant-payable-balances.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { findUserBang, NotPortedError } from "./user.ts";

type BalancesCase = GoldenCase & { balance_ids: number[] | null; cents_on_stripe: number | null };
const golden = loadGolden(new URL("./__fixtures__/payouts-instant-balances.golden.json", import.meta.url)) as Golden & {
  cases: BalancesCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
// Ruby's sort_by is not stable: balances that share a date come back in no promised order, so those are compared as sets.
const TIED_ORDER = "Gumroad-held and Stripe-held balances share the day";
let ids: number[] | null = null;
let cents: number | null = null;

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

beforeEach(() => {
  ids = null;
  cents = null;
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
});

afterEach(() => resetPayoutReadCollaborators());

const action = (c: BalancesCase) => async () => {
  const user = await findUserBang(5);
  if (c.cents_on_stripe !== null) cents = await instantlyPayableAmountCentsOnStripe(user);
  else ids = (await instantlyPayableUnpaidBalances(user, { now })).map((balance) => Number(balance.get("id")));
};

describe("instantly payable unpaid balances", () => {
  for (const c of golden.cases) {
    // A PayPal-held balance has no holder Node can name: refused below instead.
    if (c.name.includes("PayPal")) continue;
    it(c.name, async () => {
      const replay = await replayCase(golden, c, action(c));
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(c.name === TIED_ORDER ? ids?.toSorted() : ids).toEqual(
        c.name === TIED_ORDER ? c.balance_ids?.toSorted() : c.balance_ids,
      );
      expect(cents).toEqual(c.cents_on_stripe);
    });
  }

  it("refuses a balance on a PayPal account, whose holder of funds is not ported", async () => {
    const c = golden.cases.find((candidate) => candidate.name.includes("PayPal"))!;
    const replay = await replayCase(golden, c, action(c));
    expect(replay.error).toBeInstanceOf(NotPortedError);
  });

  it("refuses a balance that names no merchant account", async () => {
    const c = structuredClone(golden.cases[0]!);
    for (const statement of c.statements) {
      if (statement.sql?.startsWith("SELECT `merchant_accounts`.*")) statement.result!.rows = [];
    }
    const replay = await replayCase(golden, c, action(c));
    expect(replay.error).toBeInstanceOf(NotPortedError);
  });
});
