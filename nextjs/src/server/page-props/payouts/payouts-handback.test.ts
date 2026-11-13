import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { getRedis } from "../../infra/redis.ts";
import { balanceStatsCacheKey } from "../../models/user-balance-stats.ts";
import { InvalidRequestError } from "../../stripe/errors.ts";
import { Account, Balance } from "../../stripe/resources.ts";

import { planPayouts, payoutsProps } from "./payouts.ts";

// What the Payouts page cannot answer goes to Rails whole. These rows are written with ids far above anything a
// replay seeds and removed afterwards; the test needs the database of the parity runs.
const url = process.env.PARITY_DATABASE_URL;
const USER_ID = 9_100_001;
const NOW = new Date("2026-03-04T12:00:00Z");

async function reset() {
  await db.$executeRawUnsafe(`DELETE FROM payments WHERE user_id = ${USER_ID}`);
  await db.$executeRawUnsafe(`DELETE FROM user_compliance_info WHERE user_id = ${USER_ID}`);
  await db.$executeRawUnsafe(`DELETE FROM users WHERE id = ${USER_ID}`);
}

async function seller(attributes: { risk?: string; country?: string; json?: string; completedPayout?: boolean } = {}) {
  await reset();
  await db.$executeRawUnsafe(
    `INSERT INTO users (id, email, recommendation_type, user_risk_state, json_data, created_at, updated_at) VALUES (${USER_ID}, 'handback@example.com', 'own_products', '${attributes.risk ?? "compliant"}', ${attributes.json ? `'${attributes.json}'` : "NULL"}, NOW(), NOW())`,
  );
  if (attributes.country) {
    await db.$executeRawUnsafe(
      `INSERT INTO user_compliance_info (user_id, country, is_business, created_at, updated_at) VALUES (${USER_ID}, '${attributes.country}', 0, NOW(), NOW())`,
    );
  }
  if (attributes.completedPayout) {
    await db.$executeRawUnsafe(
      `INSERT INTO payments (user_id, state, amount_cents, currency, payout_period_end_date, created_at, updated_at) VALUES (${USER_ID}, 'completed', 5000, 'usd', '2026-02-20', '2026-02-27', '2026-02-27')`,
    );
  }
  return db.user.findUniqueOrThrow({ where: { id: BigInt(USER_ID) } });
}

describe.skipIf(!url)("planPayouts hands back what it cannot prove", () => {
  beforeAll(reset);
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  it("serves a compliant seller outside the United States", async () => {
    const plan = await planPayouts(await seller({ country: "Singapore", completedPayout: true }), null, NOW);
    expect(plan.pageNumber).toBe(1);
    expect(plan.pastPayments).toHaveLength(1);
  });

  describe("a US seller with a completed payout", () => {
    const account = (created: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO merchant_accounts (user_id, charge_processor_id, charge_processor_merchant_id, charge_processor_alive_at, created_at, updated_at) VALUES (${USER_ID}, 'stripe', 'acct_handback', '${created}', '${created}', '${created}')`,
      );
    const bank = (ids: { connect?: string; external?: string }) =>
      db.$executeRawUnsafe(
        `INSERT INTO bank_accounts (user_id, type, stripe_connect_account_id, stripe_bank_account_id, created_at, updated_at) VALUES (${USER_ID}, 'AchAccount', ${ids.connect ? `'${ids.connect}'` : "NULL"}, ${ids.external ? `'${ids.external}'` : "NULL"}, NOW(), NOW())`,
      );
    const balance = (merchantAccountId: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO balances (user_id, merchant_account_id, date, amount_cents, state, created_at, updated_at) VALUES (${USER_ID}, ${merchantAccountId}, '2026-03-01', 500, 'unpaid', NOW(), NOW())`,
      );
    const user = () => seller({ country: "United States", completedPayout: true });
    afterEach(async () => {
      await db.$executeRawUnsafe(`DELETE FROM merchant_accounts WHERE user_id = ${USER_ID}`);
      await db.$executeRawUnsafe(`DELETE FROM bank_accounts WHERE user_id = ${USER_ID}`);
      await db.$executeRawUnsafe(`DELETE FROM balances WHERE user_id = ${USER_ID}`);
    });

    it("is not eligible without a payout account", async () => {
      expect((await planPayouts(await user(), null, NOW)).showInstantPayoutsNotice).toBe(false);
    });

    it("is eligible with a seasoned account and no bank account", async () => {
      const seller = await user();
      await account("2026-01-01");
      expect((await planPayouts(seller, null, NOW)).showInstantPayoutsNotice).toBe(true);
    });

    it("is eligible with a seasoned account and a bank account missing either Stripe id", async () => {
      for (const ids of [{}, { connect: "acct_1" }, { external: "ba_1" }]) {
        const seller = await user();
        await account("2026-01-01");
        await bank(ids);
        expect((await planPayouts(seller, null, NOW)).showInstantPayoutsNotice, JSON.stringify(ids)).toBe(true);
        await db.$executeRawUnsafe(`DELETE FROM bank_accounts WHERE user_id = ${USER_ID}`);
      }
    });

    describe("with a seasoned account and a bank account carrying both Stripe ids", () => {
      const read = (...answers: unknown[]) => {
        const spy = vi.spyOn(Account, "retrieveExternalAccount");
        for (const answer of answers) {
          if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
          else spy.mockResolvedValueOnce(answer as never);
        }
        return spy;
      };
      const standard = { available_payout_methods: ["standard"] };
      const instant = { available_payout_methods: ["standard", "instant"] };
      const prepare = async () => {
        const seller = await user();
        await account("2026-01-01");
        await bank({ connect: "acct_1", external: "ba_1" });
        return seller;
      };
      afterEach(() => vi.restoreAllMocks());

      it("offers the notice when Stripe lists no instant payouts, after the two reads Rails makes", async () => {
        const spy = read(standard, standard);
        const plan = await planPayouts(await prepare(), null, NOW);
        expect(plan.showInstantPayoutsNotice).toBe(true);
        expect(plan.instantReads).toEqual([false, false]);
        expect(spy.mock.calls.map(([account, external]) => [account, external])).toEqual([
          ["acct_1", "ba_1"],
          ["acct_1", "ba_1"],
        ]);
      });

      it("withholds the notice when only the second read lists instant payouts", async () => {
        read(standard, instant);
        expect((await planPayouts(await prepare(), null, NOW)).showInstantPayoutsNotice).toBe(false);
      });

      it("offers the notice when Stripe refuses the read", async () => {
        read(new InvalidRequestError("No such external account: 'ba_1'", null), new InvalidRequestError("boom", null));
        const plan = await planPayouts(await prepare(), null, NOW);
        expect(plan.showInstantPayoutsNotice).toBe(true);
      });

      it("reuses the reads of the filter instead of asking Stripe again", async () => {
        const spy = read();
        const plan = await planPayouts(await prepare(), null, NOW, { instantReads: [false, false] });
        expect(plan.showInstantPayoutsNotice).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      });

      describe("when Stripe lists instant payouts for the bank account", () => {
        const GUMROAD_ACCOUNT = 9_100_002;
        const stripeBalance = { instant_available: [] };
        const prepared = async () => {
          const seller = await prepare();
          await db.$executeRawUnsafe(`UPDATE bank_accounts SET bank_number = '110000000' WHERE user_id = ${USER_ID}`);
          return seller;
        };
        const gumroadAccount = () =>
          db.$executeRawUnsafe(
            `INSERT INTO merchant_accounts (id, user_id, charge_processor_id, charge_processor_merchant_id, charge_processor_alive_at, created_at, updated_at) VALUES (${GUMROAD_ACCOUNT}, NULL, 'stripe', 'acct_gumroad_handback', '2026-01-01', '2026-01-01', '2026-01-01')`,
          );
        const unpaid = (
          date: string,
          holding: string,
          merchantAccountId: string | number = GUMROAD_ACCOUNT,
          amount = holding === "NULL" ? 0 : holding,
        ) =>
          db.$executeRawUnsafe(
            `INSERT INTO balances (user_id, merchant_account_id, date, amount_cents, holding_amount_cents, state, created_at, updated_at) VALUES (${USER_ID}, ${merchantAccountId}, '${date}', ${amount}, ${holding}, 'unpaid', NOW(), NOW())`,
          );
        // The order Rails reads in: the external account, three balances, the external account again.
        const reads = (...external: unknown[]) => {
          const order: string[] = [];
          vi.spyOn(Account, "retrieveExternalAccount").mockImplementation(() => {
            order.push("external account");
            return Promise.resolve((external.shift() ?? instant) as never);
          });
          const balance = vi.spyOn(Balance, "retrieve").mockImplementation(() => {
            order.push("balance");
            return Promise.resolve(stripeBalance as never);
          });
          return { order, balance };
        };
        afterEach(async () => {
          await db.$executeRawUnsafe(`DELETE FROM merchant_accounts WHERE id = ${GUMROAD_ACCOUNT}`);
          await db.$executeRawUnsafe(`DELETE FROM banks WHERE routing_number = 'handback-routing'`);
        });

        it("builds the instant payout props from three balance reads between the two external account reads", async () => {
          const { order, balance } = reads();
          const seller = await prepared();
          await gumroadAccount();
          await unpaid("2026-03-01", "1500");
          await unpaid("2026-02-20", "2700", GUMROAD_ACCOUNT, "3000");
          await unpaid("2026-03-10", "400");
          const plan = await planPayouts(seller, null, NOW);
          expect(order).toEqual(["external account", "balance", "balance", "balance", "external account"]);
          expect(balance.mock.calls[0]).toEqual([
            { expand: ["instant_available.net_available"] },
            { stripeAccount: "acct_1" },
          ]);
          expect(plan.showInstantPayoutsNotice).toBe(false);
          expect(plan.instantPayout).toMatchObject({
            instant_payout_fee_percent: 3,
            payable_amount_cents: 4200,
            unpaid_amount_cents: 400,
            bank_account_type: "ACH",
            bank_name: null,
            account_number: "******",
          });
          expect(plan.instantPayout?.payable_balances.map(({ date, amount_cents }) => [date, amount_cents])).toEqual([
            ["2026-03-01", 1500],
            ["2026-02-20", 2700],
          ]);
        });

        it("keeps the props and offers the notice when the second read lists standard payouts only", async () => {
          reads(instant, standard);
          const seller = await prepared();
          await gumroadAccount();
          await unpaid("2026-03-01", "1500");
          const plan = await planPayouts(seller, null, NOW);
          expect(plan.showInstantPayoutsNotice).toBe(true);
          expect(plan.instantReads).toEqual([true, false]);
          expect(plan.instantPayout?.payable_amount_cents).toBe(1500);
        });

        it("names the bank of the routing number", async () => {
          reads();
          const seller = await prepared();
          await gumroadAccount();
          await db.$executeRawUnsafe(
            `UPDATE bank_accounts SET bank_number = 'handback-routing' WHERE user_id = ${USER_ID}`,
          );
          await db.$executeRawUnsafe(
            `INSERT INTO banks (routing_number, name) VALUES ('handback-routing', 'Handback Bank')`,
          );
          const plan = await planPayouts(seller, null, NOW);
          expect(plan.instantPayout).toMatchObject({ bank_name: "Handback Bank", routing_number: "handback-routing" });
        });

        it("hands back a routing number two banks share", async () => {
          reads();
          const seller = await prepared();
          await gumroadAccount();
          await db.$executeRawUnsafe(
            `UPDATE bank_accounts SET bank_number = 'handback-routing' WHERE user_id = ${USER_ID}`,
          );
          await db.$executeRawUnsafe(
            `INSERT INTO banks (routing_number, name) VALUES ('handback-routing', 'One'), ('handback-routing', 'Two')`,
          );
          await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
        });

        it("reuses the stored props instead of reading Stripe again", async () => {
          const { order } = reads();
          const stored = { instant_payout_fee_percent: 3 } as never;
          const plan = await planPayouts(await prepared(), null, NOW, {
            instantReads: [true, true],
            instantPayout: stored,
          });
          expect(plan.instantPayout).toBe(stored);
          expect(order).toEqual([]);
        });

        it("hands back when Stripe refuses a balance read", async () => {
          reads();
          vi.spyOn(Balance, "retrieve").mockRejectedValue(new InvalidRequestError("boom", null));
          const seller = await prepared();
          await gumroadAccount();
          await unpaid("2026-03-01", "1500");
          await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
        });

        it("hands back balances that share a date: Ruby's sort_by is not stable", async () => {
          reads();
          const seller = await prepared();
          await gumroadAccount();
          await unpaid("2026-03-01", "1500");
          await unpaid("2026-03-01", "700");
          await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
        });

        it("hands back a balance that names no merchant account", async () => {
          reads();
          const seller = await prepared();
          await unpaid("2026-03-01", "1500", "NULL");
          await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
        });

        it("hands back a balance without a holding amount", async () => {
          reads();
          const seller = await prepared();
          await gumroadAccount();
          await unpaid("2026-03-01", "NULL");
          await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
        });
      });

      it("hands back an external account answered without its payout methods", async () => {
        read({});
        await expect(planPayouts(await prepare(), null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
      });

      it("hands back a partial reload without asking Stripe: Rails asks only for the props requested", async () => {
        const spy = read();
        await expect(planPayouts(await prepare(), null, NOW, { partial: true })).rejects.toBeInstanceOf(
          HandBackToRails,
        );
        expect(spy).not.toHaveBeenCalled();
      });

      it("hands back a daily schedule, which asks Stripe again", async () => {
        read(standard, standard);
        const seller = await prepare();
        await db.$executeRawUnsafe(`UPDATE users SET json_data = '{"payout_frequency":"daily"}' WHERE id = ${USER_ID}`);
        await expect(
          planPayouts(await db.user.findUniqueOrThrow({ where: { id: seller.id } }), null, NOW),
        ).rejects.toBeInstanceOf(HandBackToRails);
      });
    });

    it("serves an unseasoned account whose bank account carries both Stripe ids", async () => {
      const seller = await user();
      await account("2026-03-01");
      await bank({ connect: "acct_1", external: "ba_1" });
      expect((await planPayouts(seller, null, NOW)).showInstantPayoutsNotice).toBe(false);
    });

    it("hands back a seller whose unpaid balance Stripe holds: a second destination is possible", async () => {
      const seller = await user();
      await account("2026-01-01");
      await balance(`(SELECT id FROM merchant_accounts WHERE user_id = ${USER_ID} LIMIT 1)`);
      await expect(planPayouts(seller, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
    });
  });

  it("serves a US seller that has not been paid yet", async () => {
    const plan = await planPayouts(await seller({ country: "United States" }), null, NOW);
    expect(plan.pastPayments).toEqual([]);
  });

  it("serves daily payouts of a compliant seller who cannot be paid instantly on the weekly schedule", async () => {
    const plan = await planPayouts(await seller({ json: '{"payout_frequency":"daily"}' }), null, NOW);
    expect(plan.dailyFallback).toBe(true);
    expect(plan.frequency).toBe("weekly");
  });

  it("hands back daily payouts of a compliant seller whose bank account Stripe may support instantly", async () => {
    const user = await seller({
      country: "United States",
      completedPayout: true,
      json: '{"payout_frequency":"daily"}',
    });
    await db.$executeRawUnsafe(
      `INSERT INTO merchant_accounts (user_id, charge_processor_id, charge_processor_merchant_id, charge_processor_alive_at, created_at, updated_at) VALUES (${USER_ID}, 'stripe', 'acct_handback', '2026-01-01', '2026-01-01', '2026-01-01')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO bank_accounts (user_id, type, stripe_connect_account_id, stripe_bank_account_id, created_at, updated_at) VALUES (${USER_ID}, 'AchAccount', 'acct_1', 'ba_1', NOW(), NOW())`,
    );
    try {
      await expect(planPayouts(user, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM merchant_accounts WHERE user_id = ${USER_ID}`);
      await db.$executeRawUnsafe(`DELETE FROM bank_accounts WHERE user_id = ${USER_ID}`);
    }
  });

  it("serves daily payouts of a seller that is not compliant on the weekly schedule", async () => {
    const plan = await planPayouts(
      await seller({ risk: "not_reviewed", json: '{"payout_frequency":"daily"}' }),
      null,
      NOW,
    );
    expect(plan.dailyFallback).toBe(true);
    expect(plan.frequency).toBe("weekly");
  });

  it("serves a US seller whose only payout account is not seasoned yet", async () => {
    const user = await seller({ country: "United States", completedPayout: true });
    await db.$executeRawUnsafe(
      `INSERT INTO merchant_accounts (user_id, charge_processor_id, charge_processor_merchant_id, charge_processor_alive_at, created_at, updated_at) VALUES (${USER_ID}, 'stripe', 'acct_handback', '2026-03-01', '2026-03-01', '2026-03-01')`,
    );
    try {
      const plan = await planPayouts(user, null, NOW);
      expect(plan.pastPayments).toHaveLength(1);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM merchant_accounts WHERE user_id = ${USER_ID}`);
    }
  });

  it("serves a payout in a currency the money gem knows", async () => {
    const user = await seller({ completedPayout: true });
    await db.$executeRawUnsafe(`UPDATE payments SET currency = 'eur' WHERE user_id = ${USER_ID}`);
    expect((await planPayouts(user, null, NOW)).pastPayments).toHaveLength(1);
  });

  it("hands back a payout in a currency the money gem does not know", async () => {
    const user = await seller({ completedPayout: true });
    await db.$executeRawUnsafe(`UPDATE payments SET currency = 'xxq' WHERE user_id = ${USER_ID}`);
    await expect(planPayouts(user, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
  });

  describe("a seller whose balance stats are cached", () => {
    const redis = () => getRedis("main");
    const cacheable = async (attributes: Parameters<typeof seller>[0] = {}) => {
      const user = await seller(attributes);
      await redis().set("balance_stats:sales_caching_threshold", "10");
      await db.$executeRawUnsafe(
        `INSERT INTO large_sellers (user_id, sales_count, created_at, updated_at) VALUES (${USER_ID}, 10, NOW(), NOW())`,
      );
      return user;
    };
    const cleanUp = async () => {
      await redis().del(
        balanceStatsCacheKey(USER_ID),
        "balance_stats:sales_caching_threshold",
        "balance_stats:users_excluded_from_caching",
      );
      await db.$executeRawUnsafe(`DELETE FROM large_sellers WHERE user_id = ${USER_ID}`);
    };
    afterEach(cleanUp);

    it("serves the two periods of a cached blob as stored", async () => {
      const user = await cacheable();
      await redis().set(
        balanceStatsCacheKey(USER_ID),
        JSON.stringify({
          generated_at: "2026-03-04T11:00:00Z",
          next_payout_period_data: { status: "payable", payout_cents: 1 },
          processing_payout_periods_data: [{ payout_cents: 2 }],
        }),
      );
      const plan = await planPayouts(user, null, NOW);
      expect(plan.refreshBalanceStatsCache).toBe(true);
      expect(plan.cached).toEqual({ next: { status: "payable", payout_cents: 1 }, processing: [{ payout_cents: 2 }] });
    });

    it("serves a blob whose next period is null", async () => {
      const user = await cacheable();
      await redis().set(
        balanceStatsCacheKey(USER_ID),
        JSON.stringify({ next_payout_period_data: null, processing_payout_periods_data: [] }),
      );
      expect((await planPayouts(user, null, NOW)).cached).toEqual({ next: null, processing: [] });
    });

    it("hands back a blob Rails would raise on", async () => {
      const user = await cacheable();
      const key = balanceStatsCacheKey(USER_ID);
      for (const blob of [
        { next_payout_period_data: null },
        { next_payout_period_data: false, processing_payout_periods_data: [] },
        { next_payout_period_data: null, processing_payout_periods_data: {} },
        { next_payout_period_data: null, processing_payout_periods_data: ["x"] },
        [],
        "text",
        true,
      ]) {
        await redis().set(key, JSON.stringify(blob));
        await expect(planPayouts(user, null, NOW), JSON.stringify(blob)).rejects.toBeInstanceOf(HandBackToRails);
      }
    });

    it("computes live and plans the refresh job when the blob is missing", async () => {
      const plan = await planPayouts(await cacheable(), null, NOW);
      expect(plan.refreshBalanceStatsCache).toBe(true);
    });

    it("reads an unparseable or null blob as a miss", async () => {
      const user = await cacheable();
      for (const blob of ["{not json", "null", "false", ""]) {
        await redis().set(balanceStatsCacheKey(USER_ID), blob);
        expect((await planPayouts(user, null, NOW)).refreshBalanceStatsCache, blob).toBe(true);
      }
    });

    it("plans no refresh for a seller below the threshold or excluded from caching", async () => {
      const user = await cacheable();
      await redis().sadd("balance_stats:users_excluded_from_caching", String(USER_ID));
      expect((await planPayouts(user, null, NOW)).refreshBalanceStatsCache).toBe(false);
      await redis().del("balance_stats:users_excluded_from_caching");
      await redis().set("balance_stats:sales_caching_threshold", "11");
      expect((await planPayouts(user, null, NOW)).refreshBalanceStatsCache).toBe(false);
    });

    it("builds no props that enqueue the refresh for a seller that is not cacheable", async () => {
      const plan = await planPayouts(await seller(), null, NOW);
      expect(plan.refreshBalanceStatsCache).toBe(false);
      expect(payoutsProps(plan, NOW).past).toBeTypeOf("function");
    });
  });

  it("raises Pagy's overflow for a page past the last one when there are no payouts", async () => {
    await expect(planPayouts(await seller(), "3", NOW)).rejects.toThrow(RangeError);
  });
});
