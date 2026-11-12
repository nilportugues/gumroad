// SubscriptionsController#manage's before_actions (set_noindex_header, check_can_manage). The page
// (CheckoutPresenter#subscription_manager_props) is not ported: a visitor who may manage goes to Rails whole.
import type { Subscription } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { readEncryptedCookie } from "../auth/rails-cookies.ts";
import { railsCookieSecrets } from "../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { decideManageAccess, loadManageFacts } from "../page-props/buyer/subscription-manage.ts";
import { UserFlags } from "../models/user.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails } from "./application-controller.ts";
import { idFromExternalId, notFound, safeDecode } from "./buyer-pages.ts";
import { assertFlatQuery, requestFormat } from "./rails-params.ts";
import { queryParam } from "./rails-request.ts";

// SubscriptionsController#check_can_manage: who may open or cancel a subscription (the cookie its manage page set, the signed-in
// owner, team member or gifter, or an unexpired magic link token).
export async function manageDecision(chain: Chain, subscription: Subscription, tokenParam: string | null) {
  // Devise's user_signed_in? is about current_user; while impersonating, logged_in_user is someone else.
  if (chain.auth.context.impersonatedUser !== null) throw new HandBackToRails();
  const viewer = railsLoggedInUser(chain.auth.context);
  const facts = await loadManageFacts(subscription, { userId: viewer?.id ?? null, isTeamMember: viewer !== null && UserFlags.isSet(viewer.flags, "is_team_member") });
  const cookieKey = `subscription_${encryptNumeric(Number(subscription.id))}`;
  const cookieValue = readEncryptedCookie(railsCookieSecrets(), cookieKey, chain.request.cookies.get(cookieKey) ?? undefined);
  // A cookie that is not a string raises in secure_compare.
  if (cookieValue !== null && cookieValue !== undefined && typeof cookieValue !== "string") throw new HandBackToRails();

  return decideManageAccess({
    subscription,
    ...facts,
    cookieValue: (cookieValue as string | null | undefined) ?? null,
    tokenParam,
    now: chain.now,
  });
}

// Journey's escape_segment: unreserved characters, sub-delimiters, ":" and "@" stay as they are.
export const escapeSegment = (segment: string) => segment.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/gu, (char) => encodeURIComponent(char));

const MANAGE_PATH = /^\/subscriptions\/([^/.]+)\/manage$/u;

async function manageFilters(chain: Chain): Promise<FilterOutcome> {
  // A JSON request gets `{ success: false, redirect_to: ... }`, and any other format is left to Rails.
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) !== "html") throw new HandBackToRails();
  assertFlatQuery(chain.request.queryString);
  // authenticate_user! is skipped for this action; set_noindex_header runs first.
  chain.headers.set("x-robots-tag", "noindex");

  const rawId = MANAGE_PATH.exec(chain.request.path)?.[1];
  if (rawId === undefined) throw new HandBackToRails();
  const externalId = safeDecode(rawId);
  const id = idFromExternalId(externalId);
  const subscription = id === null ? null : await db.subscription.findUnique({ where: { id } });
  if (!subscription) notFound();

  const decision = await manageDecision(chain, subscription!, queryParam(chain.request, "token") ?? null);
  if (decision.kind === "not_found") notFound();
  if (decision.kind === "magic_link") {
    const location = `/subscriptions/${escapeSegment(externalId)}/magic_link/new${decision.invalid ? "?invalid=true" : ""}`;
    // A halted before_action skips the after_actions.
    return { halt: { status: 302, location, rescued: true } };
  }
  // The page itself is Rails'.
  throw new HandBackToRails();
}


export const MANAGE_OPTIONS: ActionOptions = { filters: manageFilters };
