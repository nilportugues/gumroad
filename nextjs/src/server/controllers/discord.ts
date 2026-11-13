// Integrations::DiscordController (app/controllers/integrations/discord_controller.rb): #oauth_redirect, #join_server and #leave_server.
// #server_info is not ported: it authenticates, then exchanges the OAuth code with Discord.
//
// Ported: the state redirect of #oauth_redirect (and its 404 for a seller that does not exist), its empty application layout page when
// the state names no seller (integrations-oauth-redirect.ts), and the guards of #join_server and #leave_server that answer
// `{ success: false }` before Discord is called.
// Handed to Rails whole, before any write:
//   - #oauth_redirect's empty page on a seller's subdomain (the layout was recorded on the main domain only).
//   - #join_server once the request is authorized (the OAuth exchange comes next), and #leave_server once the purchase has a Discord
//     membership to remove (the Discord API call and the soft delete).
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { isBlank } from "../html/text-helper.ts";
import { subdomainFromUsername } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, RoutingError, type ActionContext, type ActionResult } from "./application-controller.ts";
import { integrationsOauthRedirectPage } from "./integrations-oauth-redirect.ts";
import { jsonResponse } from "./json-seller.ts";
import { assertFlatQuery, cgiEscape, cgiUnescape } from "./rails-params.ts";
import { queryParam, type RailsRequest } from "./rails-request.ts";
import { grantsAccess } from "./url-redirects/access.ts";

const OAUTH_REDIRECT_PATH = "/integrations/discord/oauth_redirect";
const DISCORD_INTEGRATION_TYPE = "DiscordIntegration";

const failure = (): ActionResult => jsonResponse({ success: false }, 200, true);

// `params[name]`, which is a string only when the key is flat and has a value; a list or hash parameter was refused by
// assertFlatQuery.
const stringParam = (request: RailsRequest, name: string): string | null => queryParam(request, name) ?? null;

// Ruby truthiness: only null and false are falsy.
const rubyTruthy = (value: unknown) => value !== null && value !== undefined && value !== false;

// Purchase.find_by_external_id
async function findPurchase(externalId: string) {
  const id = decrypt(externalId);
  return id === null ? null : db.purchase.findUnique({ where: { id: BigInt(id) } });
}

// #discord_purchase_currently_entitled?
async function currentlyEntitled(
  purchase: NonNullable<Awaited<ReturnType<typeof findPurchase>>>,
  now: Date,
): Promise<boolean> {
  if (purchase.stripe_refunded === true) return false;
  if (purchase.chargeback_date !== null && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed")) return false;
  if (PurchaseFlags.isSet(purchase.flags, "is_access_revoked")) return false;
  const subscription =
    purchase.subscription_id === null
      ? null
      : await db.subscription.findUnique({ where: { id: purchase.subscription_id } });
  if (!subscription) return true;
  const product = purchase.link_id === null ? null : await db.link.findUnique({ where: { id: purchase.link_id } });
  return grantsAccess(subscription, product, now);
}

// #discord_purchase_authorized?: the signed-in purchaser (Devise's current_user, not the impersonated user), or the holder of one of
// the purchase's download tokens.
async function authorizedPurchase(
  request: RailsRequest,
  action: ActionContext,
): Promise<NonNullable<Awaited<ReturnType<typeof findPurchase>>> | null> {
  const externalId = stringParam(request, "purchase_id");
  if (isBlank(externalId)) return null;
  const purchase = await findPurchase(externalId!);
  if (!purchase || !(await currentlyEntitled(purchase, action.chain.now))) return null;
  const currentUser = action.context.loggedInUser;
  if (currentUser && purchase.purchaser_id !== null && purchase.purchaser_id === currentUser.id) return purchase;
  const token = stringParam(request, "token");
  if (token === null || isBlank(token)) return null;
  return (await db.urlRedirect.count({ where: { token, purchase_id: purchase.id } })) > 0 ? purchase : null;
}

async function joinServer(request: RailsRequest, action: ActionContext): Promise<ActionResult> {
  assertFlatQuery(request.queryString);
  if (isBlank(stringParam(request, "code")) || isBlank(stringParam(request, "purchase_id"))) return failure();
  if (!(await authorizedPurchase(request, action))) return failure();
  throw new HandBackToRails("exchanging a Discord OAuth code");
}

async function leaveServer(request: RailsRequest, action: ActionContext): Promise<ActionResult> {
  assertFlatQuery(request.queryString);
  if (isBlank(stringParam(request, "purchase_id"))) return failure();
  const purchase = await authorizedPurchase(request, action);
  if (!purchase) return failure();
  // purchase.find_integration_by_name(DISCORD): an integration of the purchase's live memberships.
  const memberships = await db.purchaseIntegration.findMany({
    where: { purchase_id: purchase.id, deleted_at: null },
    select: { integration_id: true },
  });
  const ids = memberships.map((membership) => membership.integration_id);
  if (
    ids.length === 0 ||
    (await db.integration.count({ where: { id: { in: ids }, type: DISCORD_INTEGRATION_TYPE } })) === 0
  )
    return failure();
  throw new HandBackToRails("removing a member through the Discord API");
}

async function oauthRedirect(request: RailsRequest, action: ActionContext): Promise<ActionResult> {
  assertFlatQuery(request.queryString);
  const stateParam = stringParam(request, "state");
  let state: unknown = null;
  // Ruby's JSON.parse accepts a little more than the standard (comments), so a state that fails here is Rails' to judge.
  try {
    if (!isBlank(stateParam)) state = JSON.parse(stateParam!);
  } catch {
    throw new HandBackToRails("a state that is not standard JSON");
  }
  const sellerId =
    state !== null && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>).seller_id
      : null;
  if (typeof sellerId !== "string" || isBlank(sellerId)) {
    if (request.hostWithPort !== domainConfig(process.env).domain)
      throw new HandBackToRails("an empty page rendered in the application layout of a seller's host");
    return integrationsOauthRedirectPage(request, action);
  }

  const id = decrypt(cgiUnescape(sellerId));
  // User.find(nil) and User.find(0) both raise RecordNotFound.
  if (id === null || id === 0) throw new RoutingError("Not Found");
  if (!Number.isSafeInteger(id)) throw new HandBackToRails("an id beyond what a number holds");
  const seller = await db.user.findUnique({ where: { id: BigInt(id) } });
  if (!seller) throw new RoutingError("Not Found");

  let host: string | null;
  if (rubyTruthy((state as Record<string, unknown>).is_custom_domain)) {
    const customDomain = await db.customDomain.findFirst({
      where: { user_id: Number(seller.id), deleted_at: null },
      orderBy: { id: "asc" },
    });
    host = customDomain?.domain ?? null;
  } else {
    host = subdomainFromUsername(seller.username);
  }
  // A nil host makes url_for fall back to the request's, and a seller with no custom domain is a NoMethodError.
  if (host === null || isBlank(host)) throw new HandBackToRails("a seller without a host to redirect to");

  // url_for takes the port from the request (request.optional_port) even when `host:` names its own.
  const port = /:(\d+)$/u.exec(request.hostWithPort)?.[0] ?? "";
  const code = stringParam(request, "code");
  const query = code === null ? "" : `?code=${cgiEscape(code)}`;
  return {
    status: 302,
    location: `${domainConfig(process.env).protocol}://${host.replace(/:\d+$/u, "")}${port}${OAUTH_REDIRECT_PATH}${query}`,
  };
}

export const discordHandlers = {
  discord_oauth_redirect: (request: RailsRequest, action: ActionContext) => oauthRedirect(request, action),
  discord_join_server: (request: RailsRequest, action: ActionContext) => joinServer(request, action),
  discord_leave_server: (request: RailsRequest, action: ActionContext) => leaveServer(request, action),
};
