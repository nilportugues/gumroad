// Oauth::TokensController (app/controllers/oauth/tokens_controller.rb over Doorkeeper::TokensController, doorkeeper 5.7.1): POST
// /oauth/revoke, /oauth/introspect and the token endpoint, which the MCP connectors, IFTTT and Notion alias.
//
// Revoke and introspect run in full. The token endpoint answers what fails before a credential is issued: a grant type Doorkeeper
// does not offer, an authorization_code request that is missing its code or redirect URI or whose client or grant is wrong, and a
// client_credentials request from an unknown or dynamically registered client.
//
// Handed to Rails whole, before any write: every request that would issue or refresh a token (so token generation, PKCE and
// redirect URI checks stay in Ruby), the refresh_token grant, the device-code grant (Rack::Attack throttles it per device code, and
// polling writes), a code that belongs to a dynamically registered MCP client, and any parameter that is not a string.
import { railsSessionCookieName } from "../auth/rails-session-config.ts";
import {
  type AccessGrantRow,
  type AccessTokenRow,
  accessible,
  type ApplicationRow,
  findAccessGrant,
  findAccessToken,
  findApplicationById,
  findApplicationByUid,
  revokeAccessToken,
  secretMatches,
  truthy,
} from "../models/oauth-tokens.ts";
import { NotPortedError } from "../models/user.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import type { ActionResult, Rendered } from "./application-controller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import type { Params } from "./rails-body.ts";
import { isPresent } from "./rails-request.ts";

const RUBY_FILE = "app/controllers/oauth/tokens_controller.rb";
const JSON_TYPE = "application/json; charset=utf-8";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
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
  invalid_request_unknown:
    "The request is missing a required parameter, includes an unsupported parameter value, or is otherwise malformed.",
  revoked: "The access token was revoked",
  expired: "The access token expired",
  unknown: "The access token is invalid",
  revoke_unauthorized: "You are not authorized to revoke this token",
};
const missingParam = (name: string) => `Missing required parameter: ${name}.`;

function stringParam(params: Params, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new NotPortedError(`a ${name} that is not a string`, RUBY_FILE);
  return value;
}

// The session middleware re-answers a session it was sent with its own bookkeeping, which Node does not reproduce.
function assertNoSession(input: MutationInput): void {
  if (input.request.cookies.has(railsSessionCookieName()))
    throw new NotPortedError("a request that carries a session cookie", RUBY_FILE);
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

// Gumroad's pre-check: a code of a dynamically registered MCP client answers to Mcp::DynamicClientOauth, which stays in Rails.
async function assertNotDynamicClientCode(grant: AccessGrantRow | null): Promise<void> {
  if (grant === null) return;
  const application = await findApplicationById(grant.application_id);
  if (application !== null && truthy(application.mcp_dynamic_client))
    throw new NotPortedError("a code granted to a dynamically registered client", RUBY_FILE);
}

// OAuth::AuthorizationCodeRequest#authorize, up to the validations that need the redirect URI and PKCE.
async function authorizationCode(input: MutationInput, state: string | null, now: Date): Promise<ActionResult> {
  const code = stringParam(input.params, "code");
  const grant = isPresent(code) ? await findAccessGrant(code) : null;
  await assertNotDynamicClientCode(grant);
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
  if (grant === null || grant.application_id !== client.id || !accessible(grant, now))
    return oauthError("invalid_grant", DESCRIPTIONS.invalid_grant!, BAD_REQUEST);
  throw new NotPortedError("an authorization code that passes the client and grant checks", RUBY_FILE);
}

// OAuth::ClientCredentialsRequest: the client validations run before scopes and issuance.
async function clientCredentialsGrant(input: MutationInput): Promise<ActionResult> {
  const client = await authenticateClient(clientCredentials(input));
  if (client === null) return clientError("invalid_client");
  // allow_grant_flow_for_client: a dynamically registered client only redeems authorization codes.
  if (truthy(client.mcp_dynamic_client)) return clientError("unauthorized_client");
  throw new NotPortedError("a client_credentials grant that passes the client checks", RUBY_FILE);
}

async function createToken(input: MutationInput): Promise<ActionResult> {
  assertNoSession(input);
  const grantType = stringParam(input.params, "grant_type");
  const state = stringParam(input.params, "state");
  const path = input.request.path;
  if (grantType === DEVICE_GRANT_TYPE && path === "/oauth/token")
    throw new NotPortedError("a device code grant", RUBY_FILE);
  // The `strategy` override: a blank grant_type is an authorization code exchange.
  const effective = isPresent(grantType) ? grantType : AUTHORIZATION_CODE;
  if (effective === AUTHORIZATION_CODE) return authorizationCode(input, state, new Date());
  if (effective === CLIENT_CREDENTIALS) return clientCredentialsGrant(input);
  if (effective === REFRESH_TOKEN) throw new NotPortedError("a refresh token grant", RUBY_FILE);
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
  assertNoSession(input);
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

// OAuth::TokenIntrospection: the caller proves itself with client credentials or a bearer token of the same application.
async function introspect(input: MutationInput): Promise<ActionResult> {
  assertNoSession(input);
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

const TOKEN_PATHS = [
  "/oauth/token",
  ...["muse", "claude", "chatgpt"].map((client) => `/${client}/v1/oauth2/token`),
  "/ifttt/v1/oauth2/token",
  "/notion/oauth2/token",
];

// An ActionController::API controller: no guid or CSRF token, no CSRF check.
const OPTIONS = { options: { bare: true, metal: true }, skipForgeryProtection: true } as const;

registerMutations(
  ...TOKEN_PATHS.map((pattern) => ({ method: "POST", pattern, ...OPTIONS, run: createToken })),
  { method: "POST", pattern: "/oauth/revoke", ...OPTIONS, run: revoke },
  { method: "POST", pattern: "/oauth/introspect", ...OPTIONS, run: introspect },
);

export { clientCredentials, createToken, introspect, revoke, TOKEN_PATHS };
