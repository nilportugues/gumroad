// API token authentication as ApplicationController and the API base controllers resolve it:
// Doorkeeper's token lookup (Authorization: Bearer, then the access_token and bearer_token params),
// the MCP resource binding and brand-token validity ApplicationController#doorkeeper_token adds,
// CurrentApiUser#current_api_user, `doorkeeper_authorize!` (with Api::V2::BaseController's
// deleted-owner and `account` scope overrides) and `require_oauth_scope!`.
import type { OauthAccessToken, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { domainConfig } from "../page-props/domain.ts";

// What the lookup reads of a request: Rack's `request.authorization`, the merged `request.parameters`
// (path, query and body) and `request.path`.
export type ApiRequest = { authorization: string | null; parameters: Record<string, unknown>; path: string };

export class ApiUserNotFoundError extends Error {
  constructor() {
    super("Couldn't find User");
    this.name = "ActiveRecord::RecordNotFound";
  }
}

const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// Doorkeeper::OAuth::Token.from_request over config.access_token_methods, in order; the first
// method that yields a present value wins.
function tokenFromRequest(request: ApiRequest): string | null {
  const bearer = /^Bearer /i.exec(request.authorization ?? "");
  const fromHeader = bearer ? (request.authorization ?? "").replace(/^Bearer /i, "") : null;
  for (const candidate of [fromHeader, request.parameters.access_token, request.parameters.bearer_token]) {
    if (present(candidate)) return candidate;
    if (candidate !== null && candidate !== undefined && typeof candidate !== "string") throw new TypeError(`access token parameter of type ${typeof candidate}`);
  }
  return null;
}

// Doorkeeper::OAuth::Token.authenticate: no token is hashed (hash_token_secrets is off), and
// previous_refresh_token is not a column, so no write follows the lookup.
export async function authenticateToken(request: ApiRequest): Promise<OauthAccessToken | null> {
  const value = tokenFromRequest(request);
  return value === null ? null : db.oauthAccessToken.findFirst({ where: { token: value } });
}

// Mcp::DynamicClientOauth.token_for_request: a token bound to a resource counts only at that resource.
export function tokenForRequest(token: OauthAccessToken | null, path: string): OauthAccessToken | null {
  if (token === null || !present(token.resource)) return token;
  const { protocol, domain } = domainConfig(process.env);
  return token.resource === `${protocol}://${domain}${path}` ? token : null;
}

// MobileAccountToken.team_membership_for: TeamMembership.role_admin.switchable of the token's owner.
export async function brandTeamMembership(token: OauthAccessToken | null) {
  if (token?.team_membership_id == null) return null;
  const membership = await db.teamMembership.findFirst({
    where: { id: token.team_membership_id, seller_id: BigInt(token.resource_owner_id ?? -1), role: "admin", deleted_at: null },
  });
  if (membership === null) return null;
  const seller = await db.user.findFirst({ where: { id: membership.seller_id, deleted_at: null }, select: { id: true } });
  return seller === null ? null : membership;
}

// MobileAccountToken.valid?: a brand token stays usable while the website would still let its member switch in.
async function brandTokenValid(token: OauthAccessToken): Promise<boolean> {
  if (token.team_membership_id == null) return true;
  const membership = await brandTeamMembership(token);
  if (membership === null) return false;
  const member = await db.user.findUnique({ where: { id: membership.user_id } });
  if (member === null || member.deleted_at !== null) return false;
  const invalidatedAt = member.last_active_sessions_invalidated_at;
  return invalidatedAt === null || token.created_at.getTime() > invalidatedAt.getTime();
}

// ApplicationController#doorkeeper_token
export async function doorkeeperToken(request: ApiRequest): Promise<OauthAccessToken | null> {
  const token = tokenForRequest(await authenticateToken(request), request.path);
  return token !== null && (await brandTokenValid(token)) ? token : null;
}

// CurrentApiUser#current_api_user: User.find raises for a token without an owner, or whose owner is gone.
export async function currentApiUser(token: OauthAccessToken | null): Promise<User | null> {
  if (token === null) return null;
  const user = token.resource_owner_id == null ? null : await db.user.findUnique({ where: { id: BigInt(token.resource_owner_id) } });
  if (user === null) throw new ApiUserNotFoundError();
  return user;
}

// Doorkeeper::Models::Expirable#expired?, Revocable#revoked?
const expired = (token: OauthAccessToken, now: Date) => token.expires_in !== null && now.getTime() > token.created_at.getTime() + token.expires_in * 1000;
const revoked = (token: OauthAccessToken, now: Date) => token.revoked_at !== null && token.revoked_at.getTime() <= now.getTime();
const accessible = (token: OauthAccessToken, now: Date) => !expired(token, now) && !revoked(token, now);

// Doorkeeper::Models::Scopes#includes_scope?
const includesScope = (token: OauthAccessToken, required: string[]) => {
  const held = (token.scopes ?? "").split(/\s+/).filter(Boolean);
  return required.length === 0 || required.some((scope) => held.includes(scope));
};

const REALM = "Doorkeeper";
const INVALID_TOKEN_DESCRIPTIONS = { revoked: "The access token was revoked", expired: "The access token expired", unknown: "The access token is invalid" } as const;

export type AuthorizeResult = { ok: true } | { ok: false; status: 401 | 403; headers: Record<string, string> };

export type AuthorizeOptions = {
  // Api::V2::BaseController: `account` passes every check, and a token whose owner is deleted is invalid.
  apiV2?: boolean;
  now?: Date;
  // Doorkeeper.config.default_scopes when no scope is named.
  defaultScopes?: string[];
};

// Doorkeeper::Rails::Helpers#doorkeeper_authorize!: `head 401` with WWW-Authenticate, or `head 403`,
// both with Cache-Control no-store (Doorkeeper says "no-store, no-cache"; Rails normalizes it).
export async function doorkeeperAuthorize(token: OauthAccessToken | null, scopes: string[], options: AuthorizeOptions = {}): Promise<AuthorizeResult> {
  const now = options.now ?? new Date();
  const required = [...(scopes.length > 0 ? scopes : (options.defaultScopes ?? ["view_public"])), ...(options.apiV2 ? ["account"] : [])];
  // resource_owner_deleted?, which Rails only evaluates once the checks before it have not decided.
  const ownerDeleted = async () => options.apiV2 === true && token?.resource_owner_id != null && (await currentApiUser(token))!.deleted_at !== null;
  const acceptable = token !== null && accessible(token, now) && includesScope(token, required);
  if (acceptable && !(await ownerDeleted())) return { ok: true };

  const invalid = token === null || !accessible(token, now) || (await ownerDeleted());
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (invalid) {
    const reason = token !== null && revoked(token, now) ? "revoked" : token !== null && expired(token, now) ? "expired" : "unknown";
    headers["WWW-Authenticate"] = `Bearer realm="${REALM}", error="invalid_token", error_description="${INVALID_TOKEN_DESCRIPTIONS[reason]}"`;
    return { ok: false, status: 401, headers };
  }
  return { ok: false, status: 403, headers };
}

// Array#to_sentence(last_word_connector: " or ")
function toSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

// Api::V2::BaseController#require_oauth_scope!: null when the token holds any of the scopes, else the 403 JSON.
export function requireOauthScope(token: OauthAccessToken | null, scopes: string[]): { status: 403; body: { success: false; message: string } } | null {
  if (token !== null && token.scopes !== null && includesScope(token, scopes) && scopes.length > 0) return null;
  return { status: 403, body: { success: false, message: `This endpoint requires the ${toSentence(scopes)} scope.` } };
}
