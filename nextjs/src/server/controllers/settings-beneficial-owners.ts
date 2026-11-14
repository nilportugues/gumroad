// Settings::BeneficialOwnersController (app/controllers/settings/beneficial_owners_controller.rb): the refusals ahead of the action.
// Every action reads or writes the account's Stripe Persons through StripeBeneficialOwnersManager, so a request that gets past the
// guards goes to Rails before it calls Stripe. The routes' `format: :json` default means no answer varies on Accept.
import { stripeAccountOf } from "../models/merchant-account.ts";
import { aliveUserComplianceInfoRow } from "../models/user-compliance-info.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { settingsPaymentsUserPolicy } from "../policies/settings/payments-user.ts";

import {
  HandBackToRails,
  processAction,
  type ActionContext,
  type ActionOptions,
  type ActionResult,
} from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { jsonSellerGuard, jsonResponse as guardJsonResponse } from "./seller-json-guard.ts";

const NOT_ELIGIBLE_MESSAGE = "Beneficial owners can only be managed on business accounts using Gumroad-managed Stripe.";
const FORBIDDEN = 403;
const HAND_BACK = "a beneficial owner action, which calls Stripe";

export const BENEFICIAL_OWNERS_OPTIONS: ActionOptions = {};

// StripeBeneficialOwnersManager.eligible?: a Gumroad-managed Stripe account on a business compliance revision.
async function eligible(sellerId: bigint): Promise<boolean> {
  if ((await stripeAccountOf(sellerId)) === null) return false;
  return (await aliveUserComplianceInfoRow(sellerId))?.is_business === true;
}

// `authorize [:settings, :payments, current_seller], :update?`
const authorized = (seller: NonNullable<ActionContext["context"]["currentSeller"]>) => (context: SellerContext) =>
  settingsPaymentsUserPolicy.update(context, seller);

// GET /settings/beneficial_owners
function index(action: ActionContext): Promise<ActionResult> {
  const seller = action.context.currentSeller!;
  return sellerJsonAction(
    action,
    authorized(seller),
    async () => {
      if (!(await eligible(seller.id)))
        return { ...jsonResponse({ error: NOT_ELIGIBLE_MESSAGE }, FORBIDDEN, true), rescued: true };
      throw new HandBackToRails(HAND_BACK);
    },
    { paramsRead: true },
  );
}

export const beneficialOwnersIndexResponse = (incoming: Request): Promise<Response> =>
  processAction(incoming, BENEFICIAL_OWNERS_OPTIONS, index);

async function mutate(input: MutationInput): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  const refused = await jsonSellerGuard(input, authorized(seller));
  if (refused) return { ...refused, paramsRead: true };
  if (!(await eligible(seller.id)))
    return { ...guardJsonResponse({ error: NOT_ELIGIBLE_MESSAGE }, FORBIDDEN), rescued: true, paramsRead: true };
  throw new HandBackToRails(HAND_BACK);
}

const ID = ":id([A-Za-z0-9_=-]+)";

registerMutations(
  { method: "POST", pattern: "/settings/beneficial_owners", formats: ["json"], run: mutate },
  { method: "PUT", pattern: `/settings/beneficial_owners/${ID}`, formats: ["json"], run: mutate },
  { method: "PATCH", pattern: `/settings/beneficial_owners/${ID}`, formats: ["json"], run: mutate },
  { method: "DELETE", pattern: `/settings/beneficial_owners/${ID}`, formats: ["json"], run: mutate },
);
