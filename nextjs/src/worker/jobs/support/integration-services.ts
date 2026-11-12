// Integrations::BaseIntegrationService#activate / #deactivate (and the Discord override) for Circle and Discord, as far as the jobs that
// call them are ported: every read runs in Node, and the service's own block (a CircleApi call, a Discord member removal and the
// PurchaseIntegration write that follows) hands the job back to Rails before anything is written.
import { HandBackToRuby } from "../../../server/jobs/hand-back.ts";
import {
  CIRCLE_INTEGRATION,
  discordUserIdFor,
  findEnabledIntegration,
  keepsInactiveMembers,
} from "../../../server/models/purchase-integrations.ts";
import type { PurchaseRecord } from "../../../server/models/purchase-pricing.ts";

// `Integrations::<Service>.new.activate(purchase)`. Discord's service defines no block for activate, so it only reads.
export async function activateIntegration(purchase: PurchaseRecord, name: string): Promise<void> {
  const integration = await findEnabledIntegration(purchase, name);
  if (integration === null) return;

  if (name === CIRCLE_INTEGRATION) throw new HandBackToRuby("a Circle member to add");
}

// `Integrations::<Service>.new.deactivate(purchase)`.
export async function deactivateIntegration(purchase: PurchaseRecord, name: string): Promise<void> {
  const integration = await findEnabledIntegration(purchase, name);
  if (integration === null || keepsInactiveMembers(integration)) return;

  if (name === CIRCLE_INTEGRATION) throw new HandBackToRuby("a Circle member to remove");
  // DiscordIntegrationService#deactivate does nothing for a purchase without a Discord user id.
  if (((await discordUserIdFor(purchase)) ?? "") !== "") throw new HandBackToRuby("a Discord member to remove");
}
