// Replays payouts-instant-service.golden.json (scripts/golden/payouts-instant-service.rb): the real InstantPayoutsService#perform, run by
// Ruby against a scratch database with Stripe answered by WebMock. Node must send the statements and Stripe calls Rails sent (with the same
// number of statements before each call), enqueue the same jobs and answer the same way.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  withoutJobIds,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { performInstantPayouts, type InstantPayoutsResult } from "./instant-payouts-service.ts";
import { setPrepareSleep } from "./payout-prepare.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { findUserBang, NotPortedError } from "./user.ts";

type ServiceCase = GoldenCase & {
  result: { success: boolean; error?: string } | null;
  date: string;
  sleeps: number[];
  payment: Record<string, unknown> | null;
};
const golden = loadGolden(new URL("./__fixtures__/payouts-instant-service.golden.json", import.meta.url)) as Omit<
  Golden,
  "cases"
> & {
  cases: ServiceCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
const byName = (name: string) => golden.cases.find((c) => c.name === name)!;

const slept: number[] = [];
let result: InstantPayoutsResult | null = null;

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

beforeEach(() => {
  slept.length = 0;
  result = null;
  setPrepareSleep((seconds) => Promise.resolve(void slept.push(seconds)));
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
});

afterEach(() => resetPayoutReadCollaborators());

const action = (c: ServiceCase) => async () => {
  result = await performInstantPayouts(await findUserBang(5), new Date(`${c.date}T00:00:00Z`), { now });
};

describe("InstantPayoutsService#perform", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const replay = await replayCase(golden, c, action(c));
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(c.error?.message ?? null);
      expect(result).toEqual(c.result);
      expect(slept).toEqual(c.sleeps);
      expect(replay.cache).toEqual(c.cache);
      expect(replay.redis).toEqual(withoutJobIds(c.redis));
    });
  }

  // A shape Node does not take is refused from the rows it read, before the first write or Stripe POST.
  const refusedBeforeWrites = async (c: ServiceCase, edit: (c: ServiceCase) => void) => {
    const edited = structuredClone(c);
    edit(edited);
    const replay = await replayCase(golden, edited, action(edited));
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(replay.sqlLog.filter((sql) => /^(INSERT|UPDATE|DELETE|BEGIN)/u.test(sql))).toEqual([]);
    return replay;
  };

  it("refuses a payout that Rails would split into several batches", async () => {
    await refusedBeforeWrites(byName("an instant payout for two Stripe-held balances"), (c) => {
      for (const statement of c.statements) {
        const fields = statement.result?.fields ?? [];
        const index = fields.indexOf("holding_amount_cents");
        if (index >= 0) for (const row of statement.result!.rows!) row[index] = "600000";
      }
    });
  });

  it("refuses balances created at the same instant", async () => {
    await refusedBeforeWrites(byName("an instant payout for two Stripe-held balances"), (c) => {
      for (const statement of c.statements) {
        const index = statement.result?.fields?.indexOf("created_at") ?? -1;
        if (index >= 0 && statement.sql.startsWith("SELECT `balances`.*"))
          for (const row of statement.result!.rows!) row[index] = "2025-10-25 01:00:00.000000";
      }
    });
  });
});
