// Integrations::BaseIntegrationService#activate / #deactivate (and the Discord override) for Circle and Discord, as far as the jobs that
// call them are ported. Every read runs in Node, in Rails' order, and yields the vendor calls the job would make; a job runs them only
// once it has them all, because a Discord member removal (a Discord call and a PurchaseIntegration write) hands the job back to Rails,
// which would repeat a Circle call Node had already made. Circle's calls write nothing here, so their order against SQL is not observable.
import type { Integration } from "@prisma/client";

import { HandBackToRuby } from "../../../server/jobs/hand-back.ts";
import {
  CIRCLE_INTEGRATION,
  discordUserIdFor,
  findEnabledIntegration,
  keepsInactiveMembers,
} from "../../../server/models/purchase-integrations.ts";
import type { PurchaseRecord } from "../../../server/models/purchase-pricing.ts";
import { addMember, circleHeader, removeMember } from "../../../server/services/circle-api.ts";

export type VendorCall = () => Promise<void>;

// JsonData#json_data_for_attr on a CircleIntegration: a blank value reads as nil. Anything but a string is a rendering Ruby decides.
function circleDetail(integration: Integration, name: string): string {
  let parsed: unknown = null;
  if (integration.json_data !== null && integration.json_data !== "") {
    try {
      parsed = JSON.parse(integration.json_data);
    } catch {
      throw new HandBackToRuby("a Circle integration whose details do not parse");
    }
  }
  if (parsed === null) return "";
  if (typeof parsed !== "object" || Array.isArray(parsed))
    throw new HandBackToRuby("Circle details that are not a hash");
  const value = (parsed as Record<string, unknown>)[name];
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new HandBackToRuby(`a Circle ${name} that is not a string`);
  return value.trim() === "" ? "" : value;
}

const circleApiKey = (integration: Integration) => integration.api_key ?? "";

// `Integrations::<Service>.new.activate(purchase)`. Discord's service defines no block for activate, so it only reads.
export async function activateIntegration(purchase: PurchaseRecord, name: string): Promise<VendorCall[]> {
  const integration = await findEnabledIntegration(purchase, name);
  if (integration === null || name !== CIRCLE_INTEGRATION) return [];

  const communityId = circleDetail(integration, "community_id");
  const spaceGroupId = circleDetail(integration, "space_group_id");
  const email = purchase.row.email ?? "";
  circleHeader(circleApiKey(integration));
  return [() => addMember(circleApiKey(integration), communityId, spaceGroupId, email)];
}

// `Integrations::<Service>.new.deactivate(purchase)`.
export async function deactivateIntegration(purchase: PurchaseRecord, name: string): Promise<VendorCall[]> {
  const integration = await findEnabledIntegration(purchase, name);
  if (integration === null || keepsInactiveMembers(integration)) return [];

  if (name === CIRCLE_INTEGRATION) {
    const communityId = circleDetail(integration, "community_id");
    const email = purchase.row.email ?? "";
    circleHeader(circleApiKey(integration));
    return [() => removeMember(circleApiKey(integration), communityId, email)];
  }
  // DiscordIntegrationService#deactivate does nothing for a purchase without a Discord user id.
  if (((await discordUserIdFor(purchase)) ?? "") !== "") throw new HandBackToRuby("a Discord member to remove");
  return [];
}

export async function runVendorCalls(calls: VendorCall[]): Promise<void> {
  for (const call of calls) await call();
}
