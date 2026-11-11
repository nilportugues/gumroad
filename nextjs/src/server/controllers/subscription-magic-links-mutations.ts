// Subscriptions::MagicLinksController#create: only the 404 guards run in Node. A request for an email that exists refreshes the
// subscription's token (a random value Node cannot reproduce) and sends the magic link, so Rails takes it whole.
import { db } from "../../lib/db.ts";
import { subscriptionEmails } from "../page-props/buyer/subscriptions.ts";
import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { idFromExternalId } from "./buyer-pages.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const EMAIL_SOURCES = ["subscription", "purchase", "user"] as const;

async function create({ routeParams, params }: MutationInput): Promise<ActionResult> {
  const id = idFromExternalId(routeParams.subscription_id!);
  const subscription = id === null ? null : await db.subscription.findUnique({ where: { id } });
  if (!subscription) throw new RoutingError("Not Found");

  const user = subscription.user_id === null ? null : await db.user.findUnique({ where: { id: subscription.user_id } });
  let emails: Awaited<ReturnType<typeof subscriptionEmails>>;
  try {
    emails = await subscriptionEmails(subscription, user);
  } catch (error) {
    // A subscription with no purchase raises NoMethodError in Rails.
    if (error instanceof TypeError) throw new HandBackToRails("a subscription without a purchase");
    throw error;
  }

  const source = typeof params.email_source === "string" ? params.email_source : null;
  const key = EMAIL_SOURCES.find((name) => name === source);
  if (key === undefined || emails[key] === null) throw new RoutingError("Not Found");
  throw new HandBackToRails("a magic link email (token refresh and mail)");
}

registerMutations({ method: "POST", pattern: "/subscriptions/:subscription_id/magic_link", run: create });
