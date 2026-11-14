// OauthClientAuthentication (app/controllers/concerns/oauth_client_authentication.rb): how the device flow identifies its client and
// answers a refusal. Unlike Doorkeeper's own credentials lookup it reads an HTTP Basic header through ActionController's
// `user_name_and_password`, lets a parameter win over the header and only finds applications that are not deleted.
import { type ApplicationRow, findAliveApplicationByUid, secretMatches, truthy } from "../models/oauth-tokens.ts";
import { NotPortedError } from "../models/user.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import type { Rendered } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import type { Params } from "./rails-body.ts";
import { isPresent } from "./rails-request.ts";

export const SERVER_SCOPES = [
  "view_public",
  "edit_products",
  "edit_emails",
  "view_sales",
  "view_payouts",
  "mark_sales_as_shipped",
  "refund_sales",
  "edit_sales",
  "revenue_share",
  "ifttt",
  "mobile_api",
  "creator_api",
  "view_profile",
  "edit_profile",
  "unfurl",
  "helper_api",
  "view_tax_data",
  "account",
];

const RUBY_FILE = "app/controllers/concerns/oauth_client_authentication.rb";
const JSON_TYPE = "application/json; charset=utf-8";
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_GROUP = 4;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
// "no-store, no-cache" is normalised to "no-store" by Rails' Cache-Control middleware.
const NO_STORE = "no-store";

export function stringParam(params: Params, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new NotPortedError(`a ${name} that is not a string`, RUBY_FILE);
  return value;
}

// HttpAuthentication::Basic: `request.authorization.present? && auth_scheme.downcase == "basic"`.
function authorization(input: MutationInput): { scheme: string; param: string | null } | null {
  const header = input.request.headers.get("authorization");
  if (header === null || !isPresent(header)) return null;
  const trimmed = header.trimStart();
  const scheme = trimmed.split(/\s+/u)[0] ?? "";
  // String#split(" ", 2): the parameter keeps its inner whitespace.
  const param = trimmed.slice(scheme.length).trimStart();
  return { scheme, param: param === "" ? null : param };
}

export function hasBasicCredentials(input: MutationInput): boolean {
  return authorization(input)?.scheme.toLowerCase() === "basic";
}

// `[basic_client_id, basic_client_secret]`: user_name_and_password splits the decoded header at the first colon. A scheme other than
// Basic is decoded all the same by Rails, and Base64.decode64 skips bytes that are not Base64: both stay with Rails.
function basicCredentials(input: MutationInput): [string | undefined, string | undefined] {
  const header = authorization(input);
  if (header === null) return [undefined, undefined];
  if (header.scheme.toLowerCase() !== "basic")
    throw new NotPortedError("an Authorization header that is not Basic", RUBY_FILE);
  const encoded = header.param ?? "";
  if (!STANDARD_BASE64.test(encoded) || encoded.length % BASE64_GROUP !== 0)
    throw new NotPortedError("a Basic header that is not plain Base64", RUBY_FILE);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
  } catch {
    throw new NotPortedError("a Basic header that is not UTF-8", RUBY_FILE);
  }
  if (decoded === "") return [undefined, undefined];
  const colon = decoded.indexOf(":");
  return colon === -1 ? [decoded, undefined] : [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

// `params[:x].presence || basic_x`
const presence = (value: string | null): string | null => (isPresent(value) ? value : null);

export type OauthRefusal = { error: string; description: string; status: typeof BAD_REQUEST | typeof UNAUTHORIZED };

// #authenticate_oauth_application: the application, or the refusal to render.
export async function authenticateOauthApplication(
  input: MutationInput,
): Promise<{ application: ApplicationRow; refusal: null } | { application: null; refusal: OauthRefusal }> {
  const [basicId, basicSecret] = basicCredentials(input);
  const clientId = presence(stringParam(input.params, "client_id")) ?? basicId ?? null;
  const clientSecret = presence(stringParam(input.params, "client_secret")) ?? basicSecret ?? null;
  const refuse = (error: string, description: string, status: OauthRefusal["status"]) => ({
    application: null,
    refusal: { error, description, status },
  });
  if (!isPresent(clientId)) return refuse("invalid_request", "client_id is required", BAD_REQUEST);

  const application = await findAliveApplicationByUid(clientId);
  if (application === null)
    return refuse("invalid_client", "Client authentication failed due to unknown client", UNAUTHORIZED);
  if (!truthy(application.confidential)) return { application, refusal: null };
  // valid_oauth_client_secret?
  if (isPresent(clientSecret) && secretMatches(clientSecret, application.secret)) return { application, refusal: null };
  return refuse("invalid_client", "Client authentication failed", UNAUTHORIZED);
}

// #render_oauth_json_error
export function oauthJsonError(
  input: MutationInput,
  name: string,
  description: string,
  options: { status?: number; extra?: Record<string, JsonValue> } = {},
): Rendered {
  const status = options.status ?? BAD_REQUEST;
  return {
    status,
    body: esJson({ error: name, error_description: description, ...options.extra }),
    contentType: JSON_TYPE,
    headers: {
      "cache-control": NO_STORE,
      ...(status === UNAUTHORIZED && hasBasicCredentials(input)
        ? { "www-authenticate": 'Basic realm="Doorkeeper"' }
        : {}),
    },
  };
}

export const refusalJson = (input: MutationInput, refusal: OauthRefusal): Rendered =>
  oauthJsonError(input, refusal.error, refusal.description, { status: refusal.status });

// #requested_oauth_scope_for: a present String as sent; any other present value is no scope at all; a blank one falls back to the
// application's own scopes.
export function requestedOauthScope(params: Params, application: ApplicationRow): string | null {
  const requested = params.scope;
  if (typeof requested === "string" && isPresent(requested)) return requested;
  const blank =
    requested === undefined ||
    requested === null ||
    requested === false ||
    typeof requested === "string" ||
    (Array.isArray(requested) && requested.length === 0) ||
    (typeof requested === "object" && !Array.isArray(requested) && Object.keys(requested).length === 0);
  return blank ? normalisedScopes(application.scopes) : null;
}

// String#split with no argument: ASCII whitespace only.
export const splitScopes = (value: string) => value.split(/[ \t\n\v\f\r]+/u).filter((scope) => scope !== "");
// Scopes#add dedups and Scopes#to_s joins with a space.
export const normalisedScopes = (value: string): string => [...new Set(splitScopes(value))].join(" ");

// ScopeChecker::Validator#valid?
export function validScopeString(scopeStr: string, validScopes: string[]): boolean {
  return (
    isPresent(scopeStr) &&
    !/[\n\r\t]/u.test(scopeStr) &&
    splitScopes(scopeStr).every((scope) => validScopes.includes(scope))
  );
}

// #valid_oauth_scope?: the checker runs on the string exactly as sent, against the application's scopes or else the server's.
export function validOauthScope(application: ApplicationRow, scopes: string | null): boolean {
  if (scopes === null) return false;
  const applicationScopes = splitScopes(application.scopes);
  return validScopeString(scopes, applicationScopes.length > 0 ? applicationScopes : SERVER_SCOPES);
}
