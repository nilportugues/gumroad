// Api::Mobile::AccountsController: the accounts a phone can switch between (the token's owner and the brands it is an admin of) and
// the token that switches to one. A brand token carries only the v2 scopes the member's role allows (Ai::StoreAgentScopes); the accounts
// listed here are admin memberships, so the role is always admin.
import { randomBytes } from "node:crypto";

import type { User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { getConfig } from "../infra/config.ts";
import { TeamMemberships } from "../models/team-membership.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { username } from "../models/user.ts";
import { Users } from "../models/user.ts";
import { avatarUrl, displayName } from "../page-props/signed-in/presenters.ts";
import { permittedStoreAgentScopes } from "../ai/store-agent-scopes.ts";
import { HandBackToRails } from "./application-controller.ts";
import { fetchError, FORBIDDEN, registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";
import { Prisma } from "@prisma/client";

const MOBILE_API_SCOPES = ["mobile_api"];
// OauthApplication::LEGACY_MOBILE_API_OAUTH_APPLICATION_UID
const LEGACY_MOBILE_API_OAUTH_APPLICATION_UID = "46410c2fb9aa741c1f03cdea099929c795d20de0282b352eac881dfa46b2b89c";
// MobileAccountToken::OWN_ACCOUNT_SCOPES
const OWN_ACCOUNT_SCOPES = ["mobile_api", "creator_api", "account"];
// Doorkeeper::OAuth::Helpers::UniqueToken: SecureRandom.urlsafe_base64(32)
const TOKEN_BYTES = 32;
const newToken = () => randomBytes(TOKEN_BYTES).toString("base64url");

// MobileAccountToken::BRAND_SURFACE_SCOPES
const BRAND_SURFACE_SCOPES = ["mobile_api", "creator_api"];

// MobileAccountToken.brand_scopes for an admin membership: the surface scopes plus the role's, never `account`.
const brandScopes = () =>
  [...new Set([...BRAND_SURFACE_SCOPES, ...permittedStoreAgentScopes({ hasUser: true, hasSeller: true, roles: { isAdmin: true, isMarketing: false } })].filter((scope) => scope !== "account"))].join(" ");

const impersonationRefusal = (auth: MobileAuth) =>
  auth.impersonated === null ? null : fetchError("Account switching is not available while impersonating", FORBIDDEN);

async function accountJson(user: User, active: User) {
  return {
    id: user.external_id,
    name: displayName(user, { preferEmailOverDefaultUsername: true }),
    username: username(Users.load(user)),
    avatar_url: await avatarUrl(user),
    is_active: user.id === active.id,
  };
}

// account_holder.user_memberships.switchable.role_admin, most recently used first.
async function adminMemberships(holder: User) {
  return (await prismaAuthStore.switchableMemberships(holder.id)).filter((membership) => membership.role === "admin");
}

async function index(_input: MobileInput, auth: MobileAuth | null) {
  const refused = impersonationRefusal(auth!);
  if (refused) return refused;
  const holder = auth!.accountHolder;
  const memberships = await adminMemberships(holder);
  const sellers = await db.user.findMany({ where: { id: { in: memberships.map((membership) => membership.seller_id) } } });
  const accounts = [holder, ...memberships.map((membership) => sellers.find((seller) => seller.id === membership.seller_id)!)];
  return renderJson({ success: true, accounts: await Promise.all(accounts.map((account) => accountJson(account, auth!.apiUser))) });
}

async function create(input: MobileInput, auth: MobileAuth | null) {
  const refused = impersonationRefusal(auth!);
  if (refused) return refused;
  const id = input.params.id;
  if (id === undefined || id === null || id === "") throw new HandBackToRails("a request without an id");
  if (typeof id !== "string") throw new HandBackToRails("an id that is not a string");
  const target = await db.user.findFirst({ where: { external_id: id, deleted_at: null } });
  if (target === null) return fetchError("Could not find account");

  const token = auth!.token;
  const firstParty = [getConfig("MOBILE_API_OAUTH_APPLICATION_UID"), LEGACY_MOBILE_API_OAUTH_APPLICATION_UID].filter((uid): uid is string => uid !== undefined && uid !== "");
  const application = await db.oauthApplication.findFirst({ where: { id: token.application_id, uid: { in: firstParty } } });
  if (application === null) return fetchError("You cannot switch to this account", FORBIDDEN);

  let membership: Awaited<ReturnType<typeof adminMemberships>>[number] | undefined;
  if (target.id !== auth!.accountHolder.id) {
    membership = (await adminMemberships(auth!.accountHolder)).find((candidate) => candidate.seller_id === target.id);
    if (membership === undefined) return fetchError("You cannot switch to this account", FORBIDDEN);
  }

  // brand_team_membership: back to the member's own account restores the scopes the app asks for at login.
  const scopes = membership !== undefined ? brandScopes() : auth!.accountHolder.id !== auth!.apiUser.id ? OWN_ACCOUNT_SCOPES.join(" ") : (token.scopes ?? "").split(/\s+/u).filter(Boolean).join(" ");
  const issued = await transaction(async (tx) => {
    // OauthApplication#with_application_lock(shared: true)
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM \`oauth_applications\` WHERE \`id\` = ${application.id} LOCK IN SHARE MODE`);
    return tx.oauthAccessToken.create({
      data: { application_id: application.id, resource_owner_id: Number(target.id), token: newToken(), refresh_token: newToken(), expires_in: token.expires_in, scopes, team_membership_id: membership?.id ?? null, created_at: new Date(Math.floor(Date.now() / 1000) * 1000) },
    });
  });
  if (membership !== undefined) {
    const now = new Date();
    await TeamMemberships.updateBang(TeamMemberships.load(membership), { last_accessed_at: now }, { now: () => now });
  }
  return renderJson({ success: true, access_token: issued.token, refresh_token: issued.refresh_token, expires_in: issued.expires_in, account: await accountJson(target, target) });
}

registerMobile(
  { method: "GET", pattern: "/mobile/accounts", scopes: MOBILE_API_SCOPES, run: index },
  { method: "POST", pattern: "/mobile/accounts", scopes: MOBILE_API_SCOPES, run: create },
);
