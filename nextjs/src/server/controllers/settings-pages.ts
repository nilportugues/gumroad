// The controller side of the settings pages that write the session before they render: the social
// connections page keeps the destination of a connect flow in the session (SocialConnectReturn).
import { randomBytes } from "node:crypto";

import { db } from "../../lib/db.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { settingsSocialConnectionsPolicy } from "../policies/settings/social-connections.ts";
import { domainConfig } from "../page-props/domain.ts";
import { defaultUrlOptions } from "../page-props/load-page.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import type { ActionOptions, Chain, FilterOutcome } from "./application-controller.ts";
import { assertFlatQuery } from "./rails-params.ts";
import { fullpath, queryParam } from "./rails-request.ts";

const SESSION_KEY = "social_connect_return";
// SocialConnectReturn::RETURN_LIFETIME
const RETURN_LIFETIME_SECONDS = 15 * 60;
const TOKEN_BYTES = 32;
const DASHBOARD_PATH = "/dashboard";

export const socialConnectionsGuard = settingsGuard({ authorize: settingsSocialConnectionsPolicy.show });

type StoredReturn = { token?: unknown; user_id?: unknown; destination?: unknown; created_at?: unknown };

const isHash = (value: unknown): value is StoredReturn => value !== null && typeof value === "object" && !Array.isArray(value);
const nowSeconds = (chain: Chain) => Math.floor(chain.now.getTime() / 1000);

// SocialConnectReturn#marketing_share_destination: resolved against the seller's own published
// products, so the stored path cannot be steered by the permalink in the query string.
async function marketingShareDestination(chain: Chain, userId: bigint): Promise<string | null> {
  const permalink = queryParam(chain.request, "social_connect_product") ?? "";
  if (permalink.trim() === "") return null;
  const product = await db.link.findFirst({ where: { user_id: userId, deleted_at: null, unique_permalink: permalink } });
  const published = product !== null && product.deleted_at === null && product.purchase_disabled_at === null && !product.draft;
  return published ? `/products/${product.unique_permalink}/edit/share` : null;
}

// SocialConnectReturn#social_connect_origin_destination
async function destination(chain: Chain, userId: bigint): Promise<string | null> {
  const origin = queryParam(chain.request, "social_connect_origin");
  if (origin === "onboarding") return DASHBOARD_PATH;
  if (origin === "marketing") return marketingShareDestination(chain, userId);
  return null;
}

// SocialConnectReturn#prepare_social_connect_return, which the action runs once `authorize` allows it.
async function socialConnectFilters(chain: Chain): Promise<FilterOutcome> {
  assertFlatQuery(chain.request.queryString);
  const config = domainConfig(process.env);
  const { request } = chain;
  const url = new URL(fullpath(request), `${request.protocol}${request.hostWithPort}`);
  const { context } = chain.auth;
  // The page's guard runs after the filters; a request it refuses never reaches the action, so it must
  // leave the session as it found it.
  if (await socialConnectionsGuard({ context, config, url, urlOptions: defaultUrlOptions(url, config) })) return { state: {} };

  const previous = chain.session.data[SESSION_KEY];
  delete chain.session.data[SESSION_KEY];
  const loggedIn = railsLoggedInUser(context);
  if (!loggedIn) return { state: { social_connect_return: null } };
  const target = await destination(chain, loggedIn.id);
  if (target === null) return { state: { social_connect_return: null } };
  const sellerContext = await loadSellerContext(context);
  if (loggedIn.id !== context.currentSeller?.id || !settingsSocialConnectionsPolicy.show(sellerContext)) return { state: { social_connect_return: null } };

  const age = isHash(previous) && typeof previous.created_at === "number" ? nowSeconds(chain) - previous.created_at : -1;
  if (isHash(previous) && previous.user_id === Number(loggedIn.id) && previous.destination === target && age >= 0 && age <= RETURN_LIFETIME_SECONDS) {
    chain.session.data[SESSION_KEY] = previous;
    return { state: { social_connect_return: previous.token } };
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  chain.session.data[SESSION_KEY] = { token, user_id: Number(loggedIn.id), destination: target, created_at: nowSeconds(chain) };
  return { state: { social_connect_return: token } };
}

export const SOCIAL_CONNECTIONS_OPTIONS: ActionOptions = { filters: socialConnectFilters };
