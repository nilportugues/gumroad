// Port of app/sidekiq/deactivate_integrations_worker.rb up to the first integration API call. `Purchase.find`, the purchase's
// subscription and the sibling purchases that hold a live purchase integration, and each purchase's Circle and Discord lookups
// (an integration that keeps inactive members, or a Discord one with no member to remove, changes nothing) run in Node. A Circle
// integration to leave, or a Discord member to remove, means a CircleApi / DiscordApi call and a PurchaseIntegration write, which
// hand back to Rails before anything is written, as does an id Rails casts.
// Golden: __fixtures__/deactivate-integrations-worker.golden.json (scripts/golden/deactivate-integrations-worker.rb).
import { Prisma, type Purchase, type Subscription } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import {
  CIRCLE_INTEGRATION,
  DISCORD_INTEGRATION,
  discordUserIdFor,
  findEnabledIntegration,
  keepsInactiveMembers,
} from "../../server/models/purchase-integrations.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findById, findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

// purchase.subscription.purchases.joins(:live_purchase_integrations).distinct
async function subscriptionPurchasesWithIntegrations(subscriptionId: bigint | number): Promise<PurchaseRecord[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT DISTINCT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} INNER JOIN ${table("purchase_integrations")} ON ${column("purchase_integrations", "deleted_at")} IS NULL AND ${column("purchase_integrations", "purchase_id")} = ${column("purchases", "id")} WHERE ${column("purchases", "subscription_id")} = ${subscriptionId}`,
  );
  return rows.map((row) => new PurchaseRecord(castRow<Purchase>("Purchase", row), null));
}

async function purchasesToProcess(purchase: PurchaseRecord): Promise<PurchaseRecord[]> {
  const subscriptionId = purchase.row.subscription_id;
  const subscription = subscriptionId === null ? null : await findById<Subscription>("Subscription", subscriptionId);
  if (subscription === null) return [purchase];

  const all = [purchase, ...(await subscriptionPurchasesWithIntegrations(subscription.id))];
  return all.filter((candidate, index) => all.findIndex((other) => other.id === candidate.id) === index);
}

// BaseIntegrationService#deactivate: an integration to deactivate means the service's own block, an API call.
async function deactivate(purchase: PurchaseRecord, name: string): Promise<void> {
  const integration = await findEnabledIntegration(purchase, name);
  if (integration === null || keepsInactiveMembers(integration)) return;

  if (name === CIRCLE_INTEGRATION) throw new HandBackToRuby("a Circle member to remove");
  // DiscordIntegrationService#deactivate does nothing for a purchase without a Discord user id.
  if (((await discordUserIdFor(purchase)) ?? "") !== "") throw new HandBackToRuby("a Discord member to remove");
}

export const deactivateIntegrationsWorkerWith = modelJob({ min: 1 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = new PurchaseRecord(await findByIdBang<Purchase>("Purchase", id), null);

  await beforeSideEffects(async () => {
    for (const candidate of await purchasesToProcess(purchase)) {
      for (const name of [CIRCLE_INTEGRATION, DISCORD_INTEGRATION]) await deactivate(candidate, name);
    }
  });
});
export const deactivateIntegrationsWorker = deactivateIntegrationsWorkerWith();
