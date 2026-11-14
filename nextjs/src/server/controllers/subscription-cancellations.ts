// SubscriptionsController#unsubscribe_by_seller and #unsubscribe_by_user (app/controllers/subscriptions_controller.rb): the customers
// page's "Cancel membership" and the manage page's "Cancel". Both run Subscription#cancel! (subscription-writes.ts#cancelBang).
import type { Subscription } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { cancelBang, loadSubscription } from "../models/subscription-writes.ts";
import { defaultSubscriptionDeps, SubscriptionFlags } from "../models/subscription.ts";
import { authorize } from "../policies/authorize.ts";
import { subscriptionPolicy } from "../policies/subscription.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { idFromExternalId } from "./buyer-pages.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, noContent } from "./seller-json.ts";
import { escapeSegment, manageDecision } from "./subscription-pages.ts";

const FOUND = 302;

// `Subscription.find_by_external_id(params[:id])`
async function findSubscription(externalId: string | undefined): Promise<Subscription | null> {
  const id = externalId === undefined ? null : idFromExternalId(externalId);
  return id === null ? null : db.subscription.findUnique({ where: { id } });
}

// before_action :fetch_subscription renders `{ success: false }` for an unknown subscription; a halted before_action skips the
// after_actions.
const unknownSubscription = (): ActionResult => ({ ...json({ success: false }), rescued: true });

function cancel(input: MutationInput, row: Subscription, bySeller: boolean): Promise<void> {
  const subscription = loadSubscription(row, { now: () => input.chain.now, featureActive: defaultSubscriptionDeps.featureActive });
  return cancelBang(subscription, { bySeller });
}

async function unsubscribeBySeller(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null) throw new HandBackToRails("a signed-out request");
  const row = await findSubscription(input.routeParams.id);
  if (row === null) return unknownSubscription();

  const link = row.link_id === null ? null : await db.link.findUnique({ where: { id: row.link_id }, select: { user_id: true } });
  if (link === null || link.user_id === null) throw new NotPortedError("a subscription whose product is missing");
  const denied = await authorizeJson(input, (context) => authorize(subscriptionPolicy.unsubscribeBySeller, context, link.user_id!));
  if (denied) return denied;

  await cancel(input, row, true);
  return noContent();
}

async function unsubscribeByUser(input: MutationInput): Promise<ActionResult> {
  const row = await findSubscription(input.routeParams.id);
  if (row === null) return unknownSubscription();

  // check_can_manage
  const externalId = input.routeParams.id!;
  const tokenParam = typeof input.params.token === "string" ? input.params.token : input.params.token === undefined ? null : undefined;
  if (tokenParam === undefined) throw new HandBackToRails("a token that is not a string");
  const decision = await manageDecision(input.chain, row, tokenParam);
  if (decision.kind === "not_found") throw new RoutingError("Not Found");
  if (decision.kind === "magic_link") {
    const query = decision.invalid ? "?invalid=true" : "";
    return { status: FOUND, location: `/subscriptions/${escapeSegment(externalId)}/magic_link/new${query}`, rescued: true };
  }

  const manage = `/subscriptions/${escapeSegment(externalId)}/manage`;
  const entity = SubscriptionFlags.isSet(row.flags, "is_installment_plan") ? "installment plan" : "membership";
  try {
    await cancel(input, row, false);
  } catch (error) {
    if (error instanceof RecordInvalid) return { status: FOUND, location: manage, flash: { alert: error.message } };
    throw error;
  }
  return { status: FOUND, location: manage, flash: { notice: `Your ${entity} has been cancelled.` } };
}

registerMutations(
  { method: "POST", pattern: "/subscriptions/:id/unsubscribe_by_seller", json: true, run: unsubscribeBySeller },
  { method: "POST", pattern: "/subscriptions/:id/unsubscribe_by_user", run: unsubscribeByUser },
);
