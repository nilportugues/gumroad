import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { planPayouts } from "./payouts.ts";

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
    await db.$executeRawUnsafe(`INSERT INTO user_compliance_info (user_id, country, is_business, created_at, updated_at) VALUES (${USER_ID}, '${attributes.country}', 0, NOW(), NOW())`);
  }
  if (attributes.completedPayout) {
    await db.$executeRawUnsafe(`INSERT INTO payments (user_id, state, amount_cents, currency, payout_period_end_date, created_at, updated_at) VALUES (${USER_ID}, 'completed', 5000, 'usd', '2026-02-20', '2026-02-27', '2026-02-27')`);
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
    await expect(planPayouts(await seller({ country: "United States", completedPayout: true }), null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("serves a US seller that has not been paid yet", async () => {
    const plan = await planPayouts(await seller({ country: "United States" }), null, NOW);
    expect(plan.pastPayments).toEqual([]);
  });

  it("hands back daily payouts", async () => {
    await expect(planPayouts(await seller({ json: '{"payout_frequency":"daily"}' }), null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a payout in another currency", async () => {
    const user = await seller({ completedPayout: true });
    await db.$executeRawUnsafe(`UPDATE payments SET currency = 'eur' WHERE user_id = ${USER_ID}`);
    await expect(planPayouts(user, null, NOW)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("raises Pagy's overflow for a page past the last one when there are no payouts", async () => {
    await expect(planPayouts(await seller(), "3", NOW)).rejects.toThrow(RangeError);
  });
});
