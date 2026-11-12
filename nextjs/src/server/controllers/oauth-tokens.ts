// Oauth::TokensController (app/controllers/oauth/tokens_controller.rb over Doorkeeper::TokensController, doorkeeper 5.7.1): POST
// /oauth/token with the muse, claude, chatgpt, IFTTT and Notion aliases, /oauth/revoke, /oauth/introspect and GET /oauth/token/info.
//
// The token endpoint runs the authorization_code, client_credentials, refresh_token and device-code grants in full: validation order, PKCE, the
// redirect URI check (models/oauth-redirect-uri.ts), the grant and refresh locks, the shared application lock around a refresh and
// the rows Doorkeeper writes (random urlsafe tokens, a revoked grant or refresh token). Dynamically registered MCP clients get
// Gumroad's S256 and resource checks. Handed to Rails whole, before any write: a brand account token (team membership), a
// request whose session cookie holds more than a session id, and any parameter that is not a string.
import { createHash } from "node:crypto";

import { withApplicationLock } from "../models/oauth-application-writes.ts";
import {
  findByDeviceCode,
  GRANT_TYPE,
  issuedTokenRevoked,
  poll as pollDeviceAuthorization,
  withApplicationRowLock,
} from "../models/oauth-device-authorization.ts";
import { redirectUriAllowed } from "../models/oauth-redirect-uri.ts";
import {
  type AccessGrantRow,
  type AccessTokenRow,
  accessible,
  type ApplicationRow,
  findAccessGrant,
  findAccessToken,
  findApplicationById,
  findApplicationByUid,
  insertAccessToken,
  type IssuedAccessToken,
  lockAccessGrant,
  lockAccessToken,
  revokeAccessGrant,
  revokeAccessToken,
  secretMatches,
  transaction,
  truthy,
} from "../models/oauth-tokens.ts";
import { NotPortedError } from "../models/user.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import type { ActionResult, Rendered } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import {
  authenticateOauthApplication,
  oauthJsonError,
  refusalJson,
  SERVER_SCOPES,
  splitScopes,
  stringParam,
  validScopeString,
} from "./oauth-client-authentication.ts";
import { requestUserAgent, requireRemoteIp } from "./oauth-device.ts";
import { isPresent } from "./rails-request.ts";

const RUBY_FILE = "app/controllers/oauth/tokens_controller.rb";
const JSON_TYPE = "application/json; charset=utf-8";
const DEVICE_GRANT_TYPE = GRANT_TYPE;
const AUTHORIZATION_CODE = "authorization_code";
const CLIENT_CREDENTIALS = "client_credentials";
const REFRESH_TOKEN = "refresh_token";
const DOORKEEPER_REALM = "Doorkeeper";
const TOKEN_TYPE = "Bearer";
const BASIC_PATTERN = /^Basic (.*)/u;
const BEARER_PATTERN = /^Bearer /iu;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_GROUP = 4;
const MILLISECONDS_PER_SECOND = 1000;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const BAD_REQUEST = 400;
// Doorkeeper sends "no-store, no-cache"; Rails' Cache-Control normalization keeps only no-store.
const NO_STORE = "no-store";

// doorkeeper/config/locales/en.yml, doorkeeper.errors.messages
const DESCRIPTIONS: Record<string, string> = {
  invalid_client:
    "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
  invalid_grant:
    "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
  unauthorized_client: "The client is not authorized to perform this request using this method.",
  unsupported_grant_type: "The authorization grant type is not supported by the authorization server.",
  invalid_scope: "The requested scope is invalid, unknown, or malformed.",
  invalid_request_unknown:
    "The request is missing a required parameter, includes an unsupported parameter value, or is otherwise malformed.",
  revoked: "The access token was revoked",
  expired: "The access token expired",
  unknown: "The access token is invalid",
  revoke_unauthorized: "You are not authorized to revoke this token",
};
const missingParam = (name: string) => `Missing required parameter: ${name}.`;

// An ActionController::API session holds only its session_id, and the cookie of a client that kept the one the last response set is
// answered with that session again. A cookie carrying more (a browser signed in on the website) stays in Rails.
function assertPlainSession(input: MutationInput): void {
  if (Object.keys(input.chain.session.data).some((key) => key !== "session_id"))
    throw new NotPortedError("a request whose session cookie holds more than a session id", RUBY_FILE);
}

type Credentials = { uid: string; secret: string | null };

// Doorkeeper::OAuth::Client::Credentials.from_request with the default methods: HTTP Basic, then client_id and client_secret.
function clientCredentials(input: MutationInput): Credentials | null {
  const header = input.request.headers.get("authorization");
  const basic = header === null ? null : BASIC_PATTERN.exec(header);
  if (basic !== null) {
    const encoded = basic[1]!;
    // Base64.decode64 skips what is not Base64; only the clean form is decoded here.
    if (!STANDARD_BASE64.test(encoded) || encoded.length % BASE64_GROUP !== 0)
      throw new NotPortedError("a Basic header that is not plain Base64", RUBY_FILE);
    const bytes = Buffer.from(encoded, "base64");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new NotPortedError("a Basic header that is not UTF-8", RUBY_FILE);
    }
    const colon = decoded.indexOf(":");
    const uid = colon === -1 ? decoded : decoded.slice(0, colon);
    if (isPresent(uid)) return { uid, secret: colon === -1 ? null : decoded.slice(colon + 1) };
  }
  const uid = stringParam(input.params, "client_id");
  return isPresent(uid) ? { uid, secret: stringParam(input.params, "client_secret") } : null;
}

// Server#client: Doorkeeper::Application.by_uid_and_secret.
async function authenticateClient(credentials: Credentials | null): Promise<ApplicationRow | null> {
  if (credentials === null) return null;
  const application = await findApplicationByUid(credentials.uid);
  if (application === null) return null;
  if (!isPresent(credentials.secret) && !truthy(application.confidential)) return application;
  if (credentials.secret === null) return null;
  return secretMatches(credentials.secret, application.secret) ? application : null;
}

const jsonBody = (value: Record<string, JsonValue>, status: number, headers?: Record<string, string>): Rendered => ({
  status,
  body: esJson(value),
  contentType: JSON_TYPE,
  ...(headers ? { headers } : {}),
});

// OAuth::ErrorResponse and the subclasses Doorkeeper renders: `state` is dropped when blank, and WWW-Authenticate repeats the error.
function oauthError(name: string, description: string, status: number, state?: string | null): Rendered {
  const body: Record<string, JsonValue> = { error: name, error_description: description };
  if (state !== undefined && state !== null && isPresent(state)) body.state = state;
  return jsonBody(body, status, {
    "cache-control": NO_STORE,
    "www-authenticate": `Bearer realm="${DOORKEEPER_REALM}", error="${name}", error_description="${description}"`,
  });
}

const clientError = (name: "invalid_client" | "unauthorized_client") =>
  oauthError(name, DESCRIPTIONS[name]!, UNAUTHORIZED);
const revocationRefusal = (): Rendered =>
  jsonBody({ error: "unauthorized_client", error_description: DESCRIPTIONS.revoke_unauthorized! }, FORBIDDEN);

// ---- /oauth/token

const DEFAULT_SCOPES = ["view_public"];
const S256 = "S256";
const PLAIN = "plain";

const scopeString = (scopes: string[]) => [...new Set(scopes)].join(" ");

// render_oauth_json_error: Gumroad's own 400s carry no WWW-Authenticate.
const gumroadError = (name: string, description: string): Rendered =>
  jsonBody({ error: name, error_description: description }, BAD_REQUEST, { "cache-control": NO_STORE });

// Mcp::DynamicClientOauth.code_exchange_error: credentials of a dynamically registered MCP client only redeem with S256 PKCE and for
// the resource they were granted for.
async function dynamicCodeExchangeError(grant: AccessGrantRow, input: MutationInput): Promise<Rendered | null> {
  const application = await findApplicationById(grant.application_id);
  if (application === null || !truthy(application.mcp_dynamic_client)) return null;
  if (!isPresent(grant.code_challenge) || grant.code_challenge_method !== S256)
    return gumroadError("invalid_grant", `authorization code was not issued with an ${S256} code challenge`);
  if (!isPresent(stringParam(input.params, "code_verifier")))
    return gumroadError("invalid_request", "code_verifier is required");
  if (!isPresent(grant.resource)) return gumroadError("invalid_grant", "authorization code has no bound resource");
  const resource = stringParam(input.params, "resource");
  if (isPresent(resource) && resource !== grant.resource)
    return gumroadError("invalid_target", "resource does not match the authorization request");
  return null;
}

// MobileAccountToken.valid? can only fail for a brand token (one with a team membership), whose membership, member and session
// checks stay in Rails; Mcp::DynamicClientOauth.refresh_error is the dynamic client's resource binding.
async function dynamicRefreshError(token: AccessTokenRow, input: MutationInput): Promise<Rendered | null> {
  if (token.team_membership_id !== null) throw new NotPortedError("a brand account token", RUBY_FILE);
  const application = await findApplicationById(token.application_id);
  if (application === null || !truthy(application.mcp_dynamic_client)) return null;
  if (!isPresent(token.resource)) return gumroadError("invalid_grant", "refresh token has no bound resource");
  const resource = stringParam(input.params, "resource");
  if (isPresent(resource) && resource !== token.resource)
    return gumroadError("invalid_target", "resource does not match the refresh token");
  return null;
}

const invalidGrant = (state: string | null) =>
  oauthError("invalid_grant", DESCRIPTIONS.invalid_grant!, BAD_REQUEST, state);

// Models::Expirable#expires_in_seconds, counted from the clock when the response is built.
function expiresInSeconds(expiresIn: number | null, createdAt: Date): number | null {
  if (expiresIn === null) return null;
  // ActiveRecord keeps `created_at` in whole seconds, so the count is up to a second short of the lifetime.
  const created = Math.floor(createdAt.getTime() / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
  const remaining = Math.round((created + expiresIn * MILLISECONDS_PER_SECOND - Date.now()) / MILLISECONDS_PER_SECOND);
  return Math.max(remaining, 0);
}

// OAuth::TokenResponse: blank values (no refresh token, no lifetime, empty scopes) are dropped.
function tokenResponse(token: IssuedAccessToken): Rendered {
  const body: Record<string, JsonValue> = { access_token: token.token, token_type: TOKEN_TYPE };
  const expiresIn = expiresInSeconds(token.expiresIn, token.createdAt);
  if (expiresIn !== null && expiresIn !== 0) body.expires_in = expiresIn;
  if (token.refreshToken !== null) body.refresh_token = token.refreshToken;
  if (token.scopes !== "") body.scope = token.scopes;
  body.created_at = Math.floor(token.createdAt.getTime() / MILLISECONDS_PER_SECOND);
  return jsonBody(body, 200, { "cache-control": NO_STORE });
}

// Revocable#revoked? on a row read under lock: Errors::InvalidGrantReuse renders invalid_grant.
const revokedNow = (row: { revoked_at: Date | null }, now: Date) =>
  row.revoked_at !== null && row.revoked_at.getTime() <= now.getTime();

// AuthorizationCodeRequest#validate_code_verifier
function codeVerifierMatches(grant: AccessGrantRow, codeVerifier: string | null): boolean {
  if (!isPresent(codeVerifier)) return !isPresent(grant.code_challenge);
  if (grant.code_challenge_method === S256)
    return grant.code_challenge === createHash("sha256").update(codeVerifier).digest("base64url");
  if (grant.code_challenge_method === PLAIN) return grant.code_challenge === codeVerifier;
  return false;
}

// OAuth::AuthorizationCodeRequest#authorize
async function authorizationCode(input: MutationInput, state: string | null, now: Date): Promise<ActionResult> {
  const code = stringParam(input.params, "code");
  const grant = isPresent(code) ? await findAccessGrant(code) : null;
  if (grant !== null) {
    const refused = await dynamicCodeExchangeError(grant, input);
    if (refused !== null) return refused;
  }
  if (!isPresent(code)) return oauthError("invalid_request", missingParam("code"), BAD_REQUEST, state);

  const client = await authenticateClient(clientCredentials(input));
  const redirectUri = stringParam(input.params, "redirect_uri");
  const codeVerifier = stringParam(input.params, "code_verifier");
  // validate :params
  if (grant !== null && isPresent(grant.code_challenge) && !isPresent(codeVerifier))
    return oauthError("invalid_request", missingParam("code_verifier"), BAD_REQUEST);
  if (!isPresent(redirectUri)) return oauthError("invalid_request", missingParam("redirect_uri"), BAD_REQUEST);
  // validate :client
  if (client === null) return clientError("invalid_client");
  // validate :grant
  if (grant === null || grant.application_id !== client.id || !accessible(grant, now)) return invalidGrant(null);
  // validate :redirect_uri, validate :code_verifier
  if (!redirectUriAllowed(redirectUri, grant.redirect_uri) || !codeVerifierMatches(grant, codeVerifier))
    return invalidGrant(null);

  return transaction(async () => {
    // before_successful_response: grant.lock!, then the reuse check.
    const locked = await lockAccessGrant(grant.id);
    if (locked === null || revokedNow(locked, new Date())) return invalidGrant(state);
    await revokeAccessGrant(grant.id, now);
    // Gumroad does not reuse access tokens (no reuse_access_token), so a row is always created.
    const issued = await insertAccessToken({
      applicationId: client.id,
      resourceOwnerId: grant.resource_owner_id,
      scopes: scopeString(splitScopes(grant.scopes)),
      expiresIn: null,
      useRefreshToken: true,
      resource: grant.resource,
      createdAt: now,
    });
    return tokenResponse(issued);
  });
}

// OAuth::ClientCredentialsRequest with ClientCredentials::Validator and Creator
async function clientCredentialsGrant(input: MutationInput, now: Date): Promise<ActionResult> {
  const client = await authenticateClient(clientCredentials(input));
  if (client === null) return clientError("invalid_client");
  // allow_grant_flow_for_client: a dynamically registered client only redeems authorization codes.
  if (truthy(client.mcp_dynamic_client)) return clientError("unauthorized_client");

  const applicationScopes = splitScopes(client.scopes);
  const original = stringParam(input.params, "scope");
  const requested = isPresent(original)
    ? splitScopes(original)
    : DEFAULT_SCOPES.filter((scope) => applicationScopes.includes(scope));
  const requestedString = scopeString(requested);
  // validate :scopes, on the normalised string
  const valid =
    (requested.length === 0 && applicationScopes.length === 0) ||
    validScopeString(requestedString, applicationScopes.length > 0 ? applicationScopes : SERVER_SCOPES);
  if (!valid) return oauthError("invalid_scope", DESCRIPTIONS.invalid_scope!, BAD_REQUEST);

  // custom_access_token_attributes: the `resource` parameter is stored on the token.
  const issued = await insertAccessToken({
    applicationId: client.id,
    resourceOwnerId: null,
    scopes: requestedString,
    expiresIn: null,
    useRefreshToken: false,
    resource: stringParam(input.params, "resource"),
    createdAt: now,
  });
  return tokenResponse(issued);
}

// OAuth::RefreshTokenRequest
async function refreshTokenGrant(input: MutationInput, state: string | null, now: Date): Promise<ActionResult> {
  const refreshParam = stringParam(input.params, "refresh_token");
  const old = refreshParam === null ? null : await findAccessToken("refresh_token", refreshParam);
  if (old !== null) {
    const refused = await dynamicRefreshError(old, input);
    if (refused !== null) return refused;
  }
  const credentials = clientCredentials(input);
  const client = credentials === null ? null : await authenticateClient(credentials);
  const scopeParam = stringParam(input.params, "scope") ?? stringParam(input.params, "scopes");

  const run = async (): Promise<ActionResult> => {
    // validate :token_presence, :token
    if (old === null && !isPresent(refreshParam))
      return oauthError("invalid_request", missingParam("refresh_token"), BAD_REQUEST);
    if (old === null || revokedNow(old, now)) return invalidGrant(null);
    // validate :client
    if (credentials !== null && client === null) return clientError("invalid_client");
    // validate :client_match
    if (client === null || old.application_id !== client.id) return invalidGrant(null);
    // validate :scope
    const oldScopes = splitScopes(old.scopes ?? "");
    if (isPresent(scopeParam) && !validScopeString(scopeParam, oldScopes))
      return oauthError("invalid_scope", DESCRIPTIONS.invalid_scope!, BAD_REQUEST);
    // build_scopes: the scopes asked for, else the old token's that the application still offers.
    const applicationScopes = splitScopes(client.scopes);
    const scopes = isPresent(scopeParam)
      ? splitScopes(scopeParam)
      : applicationScopes.length === 0
        ? oldScopes
        : oldScopes.filter((scope) => applicationScopes.includes(scope));

    return transaction(async () => {
      const locked = await lockAccessToken(old.id);
      if (locked === null || revokedNow(locked, new Date())) return invalidGrant(state);
      await revokeAccessToken(old.id, now);
      const issued = await insertAccessToken({
        applicationId: old.application_id,
        resourceOwnerId: old.resource_owner_id,
        scopes: scopeString(scopes),
        expiresIn: old.expires_in,
        useRefreshToken: true,
        resource: old.resource,
        createdAt: now,
      });
      return tokenResponse(issued);
    });
  };
  // Oauth::TokensController#authorize_response: the whole refresh runs under the shared application lock.
  const application = old === null ? null : await findApplicationById(old.application_id);
  return application === null ? run() : withApplicationLock(application.id, true, run);
}

// Oauth::TokensController#create_device_access_token. The connector aliases do not offer the grant.
async function deviceCodeGrant(input: MutationInput): Promise<ActionResult> {
  const { application, refusal } = await authenticateOauthApplication(input);
  if (refusal !== null) return refusalJson(input, refusal);
  if (!truthy(application.device_authorization_enabled))
    return oauthJsonError(input, "unauthorized_client", "Client is not allowed to use device authorization");
  const deviceCode = stringParam(input.params, "device_code");
  if (!isPresent(deviceCode)) return oauthJsonError(input, "invalid_request", "device_code is required");

  const expiredToken = () => oauthJsonError(input, "expired_token", "Device code is invalid or expired");
  const authorization = await findByDeviceCode(deviceCode);
  if (authorization === null) return expiredToken();

  const outcome = await pollDeviceAuthorization(authorization.id, application, {
    ipAddress: requireRemoteIp(input),
    userAgent: requestUserAgent(input),
    now: new Date(),
  });
  switch (outcome.status) {
    case "approved": {
      // `oauth_application.with_lock { ... value.reload.revoked? }`: a revoke that landed after poll! released its locks still counts.
      const issued = outcome.token;
      return withApplicationRowLock(application.id, async () =>
        (await issuedTokenRevoked(issued, new Date()))
          ? oauthJsonError(input, "access_denied", "Access was denied")
          : tokenResponse(issued),
      );
    }
    case "authorization_pending":
      return oauthJsonError(input, "authorization_pending", "Authorization is pending");
    case "slow_down":
      return oauthJsonError(input, "slow_down", "Polling too quickly", { extra: { interval: outcome.interval } });
    case "access_denied":
      return oauthJsonError(input, "access_denied", "Access was denied");
    default:
      return expiredToken();
  }
}

async function createToken(input: MutationInput): Promise<ActionResult> {
  assertPlainSession(input);
  const grantType = stringParam(input.params, "grant_type");
  const state = stringParam(input.params, "state");
  if (grantType === DEVICE_GRANT_TYPE && input.request.path === "/oauth/token") return deviceCodeGrant(input);
  // The `strategy` override: a blank grant_type is an authorization code exchange.
  const effective = isPresent(grantType) ? grantType : AUTHORIZATION_CODE;
  const now = new Date();
  if (effective === AUTHORIZATION_CODE) return authorizationCode(input, state, now);
  if (effective === CLIENT_CREDENTIALS) return clientCredentialsGrant(input, now);
  if (effective === REFRESH_TOKEN) return refreshTokenGrant(input, state, now);
  return oauthError("unsupported_grant_type", DESCRIPTIONS.unsupported_grant_type!, BAD_REQUEST, state);
}

// ---- /oauth/revoke and /oauth/introspect

// TokensController#token: the refresh token only when the hint says so, otherwise the access token first.
async function tokenFromParams(input: MutationInput): Promise<AccessTokenRow | null> {
  const value = stringParam(input.params, "token") ?? "";
  if (stringParam(input.params, "token_type_hint") === REFRESH_TOKEN) return findAccessToken("refresh_token", value);
  return (await findAccessToken("token", value)) ?? findAccessToken("refresh_token", value);
}

async function revoke(input: MutationInput): Promise<ActionResult> {
  assertPlainSession(input);
  const client = await authenticateClient(clientCredentials(input));
  if (client === null) return revocationRefusal();
  const token = await tokenFromParams(input);
  if (token === null) return jsonBody({}, 200);
  const application = await findApplicationById(token.application_id);
  if (application === null) throw new NotPortedError("a token whose application is gone", RUBY_FILE);
  // authorized?: only a confidential application's token is tied to the client that asks.
  if (truthy(application.confidential) && application.id !== client.id) return revocationRefusal();
  const now = new Date();
  if (accessible(token, now)) await revokeAccessToken(token.id, now);
  return jsonBody({}, 200);
}

// OAuth::Token.authenticate with the default methods: the Bearer header, then access_token, then bearer_token.
async function bearerToken(input: MutationInput): Promise<AccessTokenRow | null> {
  const header = input.request.headers.get("authorization");
  const fromHeader = header !== null && BEARER_PATTERN.test(header) ? header.replace(BEARER_PATTERN, "") : null;
  for (const candidate of [
    fromHeader,
    stringParam(input.params, "access_token"),
    stringParam(input.params, "bearer_token"),
  ]) {
    if (candidate !== null && isPresent(candidate)) return findAccessToken("token", candidate);
  }
  return null;
}

function invalidToken(token: AccessTokenRow | null, now: Date): Rendered {
  const reason =
    token === null
      ? "unknown"
      : token.revoked_at !== null && token.revoked_at.getTime() <= now.getTime()
        ? "revoked"
        : !accessible(token, now)
          ? "expired"
          : "unknown";
  const description = DESCRIPTIONS[reason]!;
  return jsonBody({ error: "invalid_token", error_description: description, state: "unauthorized" }, UNAUTHORIZED, {
    "cache-control": NO_STORE,
    "www-authenticate": `Bearer realm="${DOORKEEPER_REALM}", error="invalid_token", error_description="${description}"`,
  });
}

// Doorkeeper::TokenInfoController#show over the same bearer lookup: any token that is not accessible gets the generic invalid_token
// response (`OAuth::InvalidTokenResponse.new`, without the revoked or expired reason). The JSON of an accessible token carries
// `expires_in`, counted from the clock, so it stays in Rails.
async function tokenInfo(input: MutationInput): Promise<ActionResult> {
  assertPlainSession(input);
  const now = new Date();
  const token = await bearerToken(input);
  if (token === null || !accessible(token, now)) return invalidToken(null, now);
  throw new NotPortedError(
    "an accessible token, whose JSON counts expires_in from the clock",
    "doorkeeper-5.7.1/app/controllers/doorkeeper/token_info_controller.rb",
  );
}

// OAuth::TokenIntrospection: the caller proves itself with client credentials or a bearer token of the same application.
async function introspect(input: MutationInput): Promise<ActionResult> {
  assertPlainSession(input);
  const now = new Date();
  const token = await tokenFromParams(input);
  const credentials = clientCredentials(input);
  let client: ApplicationRow | null = null;
  if (credentials !== null) {
    client = await authenticateClient(credentials);
    if (client === null) return clientError("invalid_client");
  } else {
    const bearer = await bearerToken(input);
    if (bearer === null) {
      return oauthError("invalid_request", DESCRIPTIONS.invalid_request_unknown!, BAD_REQUEST);
    }
    const bearerApplication = await findApplicationById(bearer.application_id);
    const tokenApplication = token === null ? null : await findApplicationById(token.application_id);
    if ((token !== null && tokenApplication === null) || bearerApplication === null)
      throw new NotPortedError("a token whose application is gone", RUBY_FILE);
    // default allow_token_introspection: the bearer's application is the introspected token's.
    const sameToken = token !== null && bearer.token === token.token;
    const sameApplication = tokenApplication !== null && bearerApplication.id === tokenApplication.id;
    if (sameToken || !accessible(bearer, now) || !sameApplication) return invalidToken(bearer, now);
  }

  const application = token === null ? null : await findApplicationById(token.application_id);
  // `token.application` is nil only for a token whose application row is gone, which the default rule lets any client introspect.
  const allowed = client === null || application === null || application.id === client.id;
  if (token === null || !accessible(token, now) || !allowed) return jsonBody({ active: false }, 200);
  return jsonBody(
    {
      active: true,
      scope: token.scopes,
      client_id: application?.uid ?? null,
      token_type: TOKEN_TYPE,
      exp:
        token.expires_in === null
          ? 0
          : Math.floor(
              (token.created_at.getTime() + token.expires_in * MILLISECONDS_PER_SECOND) / MILLISECONDS_PER_SECOND,
            ),
      iat: Math.floor(token.created_at.getTime() / MILLISECONDS_PER_SECOND),
    },
    200,
  );
}

// Rack::Attack's `oauth_token/ip` rule counts `/oauth/token` and the muse, claude and chatgpt aliases in rack-attack.ts before the action
// chain runs, once per request whichever way it leaves; IFTTT and Notion have no throttle in rack_attack.rb.
const TOKEN_PATHS = [
  "/oauth/token",
  "/muse/v1/oauth2/token",
  "/claude/v1/oauth2/token",
  "/chatgpt/v1/oauth2/token",
  "/ifttt/v1/oauth2/token",
  "/notion/oauth2/token",
];

// An ActionController::API controller: no guid or CSRF token, no CSRF check.
const OPTIONS = { options: { bare: true, metal: true }, skipForgeryProtection: true } as const;

registerMutations(
  ...TOKEN_PATHS.map((pattern) => ({ method: "POST", pattern, ...OPTIONS, run: createToken })),
  { method: "POST", pattern: "/oauth/revoke", ...OPTIONS, run: revoke },
  { method: "POST", pattern: "/oauth/introspect", ...OPTIONS, run: introspect },
  { method: "GET", pattern: "/oauth/token/info", ...OPTIONS, run: tokenInfo },
);

export { clientCredentials, createToken, introspect, revoke, TOKEN_PATHS };
