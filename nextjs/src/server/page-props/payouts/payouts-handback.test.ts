import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { getRedis } from "../../infra/redis.ts";
import { balanceStatsCacheKey } from "../../models/user-balance-stats.ts";

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

  it("hands back a US seller with a completed payout: Stripe is asked about instant payouts", async () => {
    await expect(
      planPayouts(await seller({ country: "United States", completedPayout: true }), null, NOW),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("serves a US seller that has not been paid yet", async () => {
    const plan = await planPayouts(await seller({ country: "United States" }), null, NOW);
    expect(plan.pastPayments).toEqual([]);
  });

  it("hands back daily payouts of a compliant seller", async () => {
    await expect(planPayouts(await seller({ json: '{"payout_frequency":"daily"}' }), null, NOW)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
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

    it("hands back a seller whose blob is cached", async () => {
      const user = await cacheable();
      await redis().set(
        balanceStatsCacheKey(USER_ID),
        JSON.stringify({ next_payout_period_data: null, processing_payout_periods_data: [] }),
      );
      await expect(planPayouts(user, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
    });

    it("computes live and plans the refresh job when the blob is missing", async () => {
      const plan = await planPayouts(await cacheable(), null, NOW);
      expect(plan.refreshBalanceStatsCache).toBe(true);
    });

    it("reads an unparseable or null blob as a miss", async () => {
      const user = await cacheable();
      for (const blob of ["{not json", "null", ""]) {
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
