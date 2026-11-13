// Replays payout-users-service.golden.json (scripts/golden/payout-users-service.rb): PayoutUsersWorker and ProcessPaymentWorker for a
// Stripe payment, run by the real classes against a scratch database with Stripe answered by WebMock. Node must send the statements and
// Stripe calls Rails sent (with the same number of statements before each call), enqueue the same jobs, report the same errors and
// raise the same error.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn<(error: unknown, context?: Record<string, unknown>) => void>() }));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError }));

import {
  goldenCalls,
  goldenStatementsBeforeCall,
  loadGolden,
  replayCase,
  withoutJobIds,
  type Golden,
  type GoldenCase,
} from "./__fixtures__/payout-golden.ts";
import { findPaymentBang } from "./payment.ts";
import { setPrepareSleep } from "./payout-prepare.ts";
import { resetPayoutReadCollaborators, setPayoutReadCollaborators } from "./payout-reads.ts";
import { processPayoutUsers, processStripePayment } from "./payout-users-service.ts";
import { NotPortedError } from "./user.ts";

type UsersCase = GoldenCase & {
  call: { job: string; args: unknown[] };
  sleeps: number[];
  notified: { error: string; context: Record<string, unknown> }[];
};
const golden = loadGolden(new URL("./__fixtures__/payout-users-service.golden.json", import.meta.url)) as Omit<
  Golden,
  "cases"
> & {
  cases: UsersCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
const byName = (name: string) => golden.cases.find((c) => c.name === name)!;

const slept: number[] = [];

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});

beforeEach(() => {
  slept.length = 0;
  notifyError.mockReset();
  setPrepareSleep((seconds) => Promise.resolve(void slept.push(seconds)));
  setPayoutReadCollaborators({ isFeatureEnabled: () => Promise.resolve(false) });
});

afterEach(() => resetPayoutReadCollaborators());

const action = (c: UsersCase) => async () => {
  const args = c.call.args;
  if (c.call.job === "ProcessPaymentWorker") {
    const payment = await findPaymentBang(args[0]);
    if (payment.get("state") === "processing") await processStripePayment(payment, { now });
    return;
  }
  const [dateString, processorType, userIds, payoutType, retrying] = args;
  await processPayoutUsers(
    { dateString, processorType, userIds, payoutType: payoutType ?? "standard", retrying: retrying ?? false },
    { now },
  );
};

// ErrorNotifier.notify(error, **context): the message without the Ruby class, which Node's errors do not all carry.
const reported = () =>
  notifyError.mock.calls.map(([error, context]) => ({
    error: error instanceof Error ? error.message : String(error),
    context: context ?? {},
  }));
const expectedReports = (c: UsersCase) =>
  c.notified.map((entry) => ({
    error: entry.error.replace(/^[A-Z][A-Za-z]*(::[A-Z][A-Za-z]*)*: /u, ""),
    context: entry.context,
  }));

describe("PayoutUsersWorker and ProcessPaymentWorker for Stripe", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const replay = await replayCase(golden, c, action(c));
      expect(replay.sqlLog).toEqual(replay.expectedSql);
      expect(replay.calls).toEqual(goldenCalls(c));
      expect(replay.statementsBeforeCall).toEqual(goldenStatementsBeforeCall(c));
      expect(replay.error === null ? null : (replay.error as Error).message).toEqual(
        c.error === null ? null : expect.stringContaining(c.error.message.split("\n")[0]!.slice(0, 40)),
      );
      expect(reported().map((r) => r.error.replace(/^[A-Z][A-Za-z]*(::[A-Z][A-Za-z]*)*: /u, ""))).toEqual(
        expectedReports(c).map((r) => r.error),
      );
      expect(slept).toEqual(c.sleeps);
      expect(replay.cache).toEqual(c.cache);
      expect(replay.redis).toEqual(withoutJobIds(c.redis));
    });
  }

  // A shape Node does not take is refused from the rows it read, before the first write or Stripe POST.
  const refusedBeforeWrites = async (c: UsersCase, edit: (c: UsersCase) => void) => {
    const edited = structuredClone(c);
    edit(edited);
    const replay = await replayCase(golden, edited, action(edited));
    expect(replay.error).toBeInstanceOf(NotPortedError);
    expect(replay.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(replay.sqlLog.filter((sql) => /^(INSERT|UPDATE|DELETE|COMMIT)/u.test(sql))).toEqual([]);
  };

  it("refuses a payout through PayPal before any statement", async () => {
    await refusedBeforeWrites(byName("a weekly payout for one Stripe-held balance"), (c) => {
      c.call.args[1] = "PAYPAL";
      c.statements = [];
    });
  });

  it("refuses a retried payout before any statement", async () => {
    await refusedBeforeWrites(byName("a weekly payout for one Stripe-held balance"), (c) => {
      c.call.args.push("standard", true);
      c.statements = [];
    });
  });

  it("refuses several sellers before any statement", async () => {
    await refusedBeforeWrites(byName("a weekly payout for one Stripe-held balance"), (c) => {
      c.call.args[2] = [5, 6];
      c.statements = [];
    });
  });

  it("refuses a date that is not YYYY-MM-DD before any statement", async () => {
    await refusedBeforeWrites(byName("a weekly payout for one Stripe-held balance"), (c) => {
      c.call.args[0] = "next friday";
      c.statements = [];
    });
  });

  it("refuses a seller outside the United States before the claim commits", async () => {
    await refusedBeforeWrites(byName("a weekly payout for one Stripe-held balance"), (c) => {
      for (const statement of c.statements) {
        const index = statement.result?.fields?.indexOf("country") ?? -1;
        if (index >= 0 && statement.sql.startsWith("SELECT `user_compliance_info`.*"))
          for (const row of statement.result!.rows!) row[index] = "Thailand";
      }
    });
  });

  it("hands a Stripe payment of another currency than its account's back before the payout request", async () => {
    await refusedBeforeWrites(byName("a processing payment is paid out"), (c) => {
      for (const statement of c.statements) {
        const index = statement.result?.fields?.indexOf("currency") ?? -1;
        if (index >= 0 && statement.sql.startsWith("SELECT `payments`.*"))
          for (const row of statement.result!.rows!) row[index] = "eur";
      }
    });
  });

  it("refuses a PayPal payment before the payout request", async () => {
    await refusedBeforeWrites(byName("a processing payment is paid out"), (c) => {
      for (const statement of c.statements) {
        const index = statement.result?.fields?.indexOf("processor") ?? -1;
        if (index >= 0 && statement.sql.startsWith("SELECT `payments`.*"))
          for (const row of statement.result!.rows!) row[index] = "PAYPAL";
      }
    });
  });
});
