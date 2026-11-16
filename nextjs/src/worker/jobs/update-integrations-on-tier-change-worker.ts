// Port of app/sidekiq/update_integrations_on_tier_change_worker.rb up to the first integration API call. `Subscription.find`, the
// previous original purchase (`purchases.is_original_subscription_purchase.order(:id)[-2]`), the current one and the Circle and Discord
// lookups on both run in Node and finish a tier change that adds or removes nobody. Circle gaining or losing the buyer, or a Discord
// member to remove, means an API call and a PurchaseIntegration write, which hand back to Rails before anything is written, as does an
// id Rails casts. Golden: __fixtures__/update-integrations-on-tier-change-worker.golden.json
// (scripts/golden/update-integrations-on-tier-change-worker.rb).
import { Prisma, type Purchase, type Subscription } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import {
  CIRCLE_INTEGRATION,
  DISCORD_INTEGRATION,
  findEnabledIntegration,
} from "../../server/models/purchase-integrations.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { NoMethodError } from "../../server/models/user.ts";

import { activateIntegration, deactivateIntegration } from "./support/integration-services.ts";
import { modelJob } from "./support/job-deps.ts";

const ORIGINAL_SUBSCRIPTION_PURCHASE = 1n << 2n;
const ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE = 1n << 17n;

const original = (flags: bigint) => Prisma.sql`((${column("purchases", "flags")} & ${flags} = ${flags}))`;

// subscription.purchases.is_original_subscription_purchase.order(:id)[-2]
async function previousOriginalPurchase(subscriptionId: bigint | number): Promise<PurchaseRecord | null> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscriptionId} AND ${original(ORIGINAL_SUBSCRIPTION_PURCHASE)} ORDER BY ${column("purchases", "id")} ASC`,
  );
  const row = rows.at(-2);
  return row === undefined ? null : new PurchaseRecord(castRow<Purchase>("Purchase", row), null);
}

// subscription.original_purchase: is_original_subscription_purchase.not_is_archived_original_subscription_purchase, no order
async function currentOriginalPurchase(subscriptionId: bigint | number): Promise<PurchaseRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscriptionId} AND ${original(ORIGINAL_SUBSCRIPTION_PURCHASE)} AND ((${column("purchases", "flags")} & ${ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE} = 0)) LIMIT 1`,
  );
  return row === undefined ? null : new PurchaseRecord(castRow<Purchase>("Purchase", row), null);
}

export const updateIntegrationsOnTierChangeWorkerWith = modelJob({ min: 1 }, async ([subscriptionId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(subscriptionId, "Subscription.find"));
  const subscription = await findByIdBang<Subscription>("Subscription", id);

  // `subscription.original_purchase` is loaded once and kept for the second service.
  let current: Promise<PurchaseRecord | null> | undefined;

  await beforeSideEffects(async () => {
    for (const name of [CIRCLE_INTEGRATION, DISCORD_INTEGRATION]) {
      const previous = await previousOriginalPurchase(subscription.id);
      if (previous === null) continue;

      const oldIntegration = await findEnabledIntegration(previous, name);
      current ??= currentOriginalPurchase(subscription.id);
      const originalPurchase = await current;
      if (originalPurchase === null) throw new NoMethodError("undefined method 'find_enabled_integration' for nil");
      const newIntegration = await findEnabledIntegration(originalPurchase, name);

      if (newIntegration !== null && oldIntegration === null) await activateIntegration(originalPurchase, name);
      if (newIntegration === null && oldIntegration !== null) await deactivateIntegration(previous, name);
    }
  });
});
export const updateIntegrationsOnTierChangeWorker = updateIntegrationsOnTierChangeWorkerWith();
