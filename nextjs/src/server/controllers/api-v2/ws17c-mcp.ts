// Api::V2::McpController (the /muse, /claude and /chatgpt connector paths and the `.well-known` documents) and
// Api::V2::NotionUnfurlUrlsController. The JSON-RPC envelope and tools/list are ported (../../mcp/server.ts); a tool call runs here only for the bodies in mcp/tool-bodies.ts,
// dynamic client registration runs here (the refusals and the row with its random client id and secret), and the product preview of the Notion unfurl stays in Rails.
import { randomUUID } from "node:crypto";

import { isFeatureEnabled } from "../../infra/flipper.ts";
import { METHOD_HEADER, MCP_PROTOCOL_FLAG, NAME_HEADER, VERSION_HEADER } from "../../mcp/constants.ts";
import { recordProtocolTelemetry } from "../../mcp/protocol-telemetry.ts";
import { RpcSession, rpcHttpStatus } from "../../mcp/server.ts";
import { type PaperTrailRequest, withPaperTrailRequest } from "../../models/concerns/paper-trail.ts";
import { isInvalidUriError, rubyUriParseParts } from "../../models/concerns/ruby-uri.ts";
import { insertDynamicClient } from "../../models/oauth-application-writes.ts";
import { domainConfig } from "../../page-props/domain.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { remoteIp } from "../mutation.ts";

import { present } from "./base.ts";
import { head, renderJson, type ApiCall } from "./ws17c-base.ts";

// Mcp::OauthClientRegistration::MCP_SCOPES
const MCP_SCOPES = ["view_public", "view_profile", "view_sales", "edit_products", "view_payouts", "account"];
// Doorkeeper.configuration.public_scopes
const PUBLIC_SCOPES = [
  "edit_products",
  "edit_emails",
  "view_sales",
  "mark_sales_as_shipped",
  "edit_sales",
  "revenue_share",
  "ifttt",
  "view_profile",
  "edit_profile",
  "view_payouts",
  "view_tax_data",
  "account",
];

const baseUrl = () => {
  const { protocol, domain } = domainConfig(process.env);
  return `${protocol}://${domain}`;
};

export const status = async (): Promise<ActionResult> => renderJson({ status: "success" });

// Mcp::Server.oauth_metadata
export const oauthMetadata = async (): Promise<ActionResult> => {
  const base = baseUrl();
  return renderJson({
    issuer: base,
    authorization_endpoint: `${base}/muse/v1/oauth2/authorize`,
    token_endpoint: `${base}/muse/v1/oauth2/token`,
    registration_endpoint: `${base}/muse/v1/oauth2/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: MCP_SCOPES,
    code_challenge_methods_supported: ["S256", "plain"],
  });
};

// Mcp::Server.discovery
export const mcpDiscovery = async (): Promise<ActionResult> => {
  const base = baseUrl();
  return renderJson({
    name: "Gumroad",
    description:
      "Sell digital products. Claude, ChatGPT, Muse, and other MCP clients can list products and sales, draft and edit a product, add the files buyers receive and a cover image, publish it, and check payouts for a connected creator.",
    website: "https://gumroad.com",
    documentation: `${base}/muse`,
    mcp: `${base}/muse/v1/mcp`,
    clients: { muse: `${base}/muse/v1/mcp`, claude: `${base}/claude/v1/mcp`, chatgpt: `${base}/chatgpt/v1/mcp` },
    oauth: {
      authorization_endpoint: `${base}/muse/v1/oauth2/authorize`,
      token_endpoint: `${base}/muse/v1/oauth2/token`,
      registration_endpoint: `${base}/muse/v1/oauth2/register`,
      scopes: MCP_SCOPES,
    },
    api: `${base}/api`,
  });
};

// OpenAI's plugin review expects the token it issued and nothing else.
export const openaiAppsChallenge = async (): Promise<ActionResult> => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "";
  if (token.trim() === "") return head(404, {}, false);
  return { status: 200, body: token, contentType: "text/plain; charset=utf-8", paramsRead: true };
};

export async function protectedResourceMetadata(call: ApiCall): Promise<ActionResult> {
  const resourcePath = call.routeParams.resource_path ?? "";
  // A glob route also reads a trailing ".json" as the format.
  if (/\.[A-Za-z0-9]+$/u.test(resourcePath)) throw new HandBackToRails("a resource path with a format suffix");
  let path = resourcePath;
  if (path !== "" && !path.startsWith("/")) path = `/${path}`;
  if (path.trim() === "") path = "/muse/v1/mcp";
  const base = baseUrl();
  return renderJson({
    resource: `${base}${path}`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: MCP_SCOPES,
  });
}

// RFC 6750 challenge: `Bearer realm="Gumroad", scope="...", resource_metadata="..."`.
export const bearerChallenge = (path: string) =>
  `Bearer realm="Gumroad", scope="${MCP_SCOPES.join(" ")}", resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource${path}"`;

// The 401 of McpController: Doorkeeper's headers with its own WWW-Authenticate.
export const mcpUnauthorized = (path: string, headers: Record<string, string>) =>
  head(401, {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "WWW-Authenticate")),
    "WWW-Authenticate": bearerChallenge(path),
  });

// validate_mcp_origin and parse_rpc_body are prepended filters: they answer ahead of the rest of the chain, which Node leaves to Rails.
export function mcpPreAuth({ request, rawBody }: Pick<ApiCall, "request" | "rawBody">): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== baseUrl()) throw new HandBackToRails("an MCP request from a foreign origin");
  if (request.method === "POST") {
    try {
      JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new HandBackToRails("an MCP request body that is not JSON");
    }
  }
}

// ApplicationController#set_paper_trail_whodunnit and #info_for_paper_trail, as the REST controllers apply them: a token request holds no
// session, so nobody is the whodunnit, and every version a tool writes carries the request's ip, path and id.
export const mcpPaperTrailRequest = (request: ApiCall["request"]): PaperTrailRequest => ({
  whodunnit: null,
  controllerInfo: {
    remote_ip: remoteIp(request),
    request_path: request.path,
    request_uuid: request.headers.get("x-request-id") ?? randomUUID(),
  },
});

export const MCP_AUTHORIZE_SCOPES = [...PUBLIC_SCOPES, "view_public"];

// Api::V2::McpController#mcp. mcpPreAuth has checked that a POST body is JSON.
export async function mcp(call: ApiCall): Promise<ActionResult> {
  if (call.request.method === "GET") return head(405, { Allow: "POST" }, false);
  if (call.request.method !== "POST") throw new HandBackToRails("an MCP request with a method other than GET or POST");
  const text = new TextDecoder().decode(call.rawBody);
  // A fraction, an exponent or an integer past 2^53 would not survive JSON.parse as Ruby reads it; Rails answers those.
  // Only numbers matter: the "2.0" of `"jsonrpc":"2.0"` and any other string literal is blanked first.
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  if (/\d\.\d|\d[eE][+-]?\d|\d{16}/u.test(withoutStrings))
    throw new HandBackToRails("an MCP body with a number JavaScript cannot read exactly");
  const connector = call.url.pathname.split("/")[1] ?? null;
  const session = new RpcSession(
    {
      protocolVersion: call.request.headers.get(VERSION_HEADER),
      method: call.request.headers.get(METHOD_HEADER),
      name: call.request.headers.get(NAME_HEADER),
    },
    () => isFeatureEnabled(MCP_PROTOCOL_FLAG),
    { user: call.owner, token: call.token },
  );
  const reply = await withPaperTrailRequest(mcpPaperTrailRequest(call.request), () => session.handle(JSON.parse(text)));
  // A tool call that hands back leaves before this point, so Rails records its own requests.
  await recordProtocolTelemetry(connector, session.counts);
  if (reply === null) return head(202, {}, false);
  return renderJson(reply, rpcHttpStatus(reply, session.protocolEra));
}

export const NOTION_UNAUTHORIZED = {
  error: {
    status: 401,
    message: "Request need to be authorized. Required parameter for authorizing request is missing or invalid.",
  },
};

export async function notionUnfurl(call: ApiCall): Promise<ActionResult> {
  const uri = call.params.uri;
  if (uri === undefined || uri === null || (typeof uri === "string" && uri.trim() === ""))
    return { ...renderJson({ error: { status: 404, message: "Product not found" } }, 404), rescued: true };
  // The product preview (rating counts, formatted price, cover image) is built by Rails.
  throw new HandBackToRails("a Notion link preview");
}

export const renderUnauthorized = () => renderJson(NOTION_UNAUTHORIZED, 401);

// DELETE /notion/unfurl: nothing to unfurl, nothing to authorize.
export const notionUnfurlDestroy = async (): Promise<ActionResult> => head(200, {}, false);

// Mcp::OauthClientRegistration
const REDIRECT_URIS_MAX = 10;
const REDIRECT_URIS_MAX_LENGTH = 255;
const TOKEN_ENDPOINT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

class RegistrationError extends Error {}

// String#strip: ASCII whitespace and NUL.
const rubyStrip = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");
const truthy = (value: unknown) => value !== undefined && value !== null && value !== false;

// `Array(raw).flatten`, then `uri.to_s.strip`: a number or a boolean can only ever read as a URL without a host, so it stands in as "0".
function redirectUris(params: Record<string, unknown>): string[] {
  const raw = [params.redirect_uris, params.redirect_uri].find(truthy);
  if (raw !== undefined && typeof raw === "object" && !Array.isArray(raw))
    throw new HandBackToRails("redirect_uris as a hash");
  const entries = [raw].flat(Infinity).filter((entry) => entry !== undefined);
  if (entries.length > REDIRECT_URIS_MAX)
    throw new RegistrationError(`redirect_uris must contain at most ${REDIRECT_URIS_MAX} entries`);
  const strings = entries.map((entry) => {
    if (entry === null) return "";
    if (typeof entry === "string") return rubyStrip(entry);
    if (typeof entry === "object") throw new HandBackToRails("a hash inside redirect_uris");
    return "0";
  });
  return [...new Set(strings.filter(present))];
}

function validateRedirectUri(value: string): void {
  if (value.includes("*")) throw new RegistrationError("redirect_uris must not contain wildcards");
  let parts;
  try {
    parts = rubyUriParseParts(value);
  } catch (error) {
    if (isInvalidUriError(error)) throw new RegistrationError("redirect_uris must be valid URLs");
    throw new HandBackToRails("a redirect URI whose components Ruby's URI rejects");
  }
  if (!present(parts.host)) throw new RegistrationError("redirect_uris must be absolute http(s) URLs");
  if (present(parts.fragment)) throw new RegistrationError("redirect_uris must not include a fragment");
  const https = parts.scheme === "https";
  const localHttp = parts.scheme === "http" && LOCAL_HOSTS.includes(parts.host!);
  if (!https && !localHttp) throw new RegistrationError("redirect_uris must be https (or http on localhost)");
}

// `(@params["x"] || @params[:x]).to_s`, for a value a client can only send as a string or leave out.
function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (!truthy(value)) return "";
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  return value;
}

const NAME_MAX = 80;
const OMISSION = "...";
// Characters whose blank? answer in Ruby is not the Unicode White_Space property, so a name holding one goes to Rails.
const AMBIGUOUS_BLANK = /[\u180e\u200b-\u200d\u2060\ufeff]/u;

type Registration = { redirectUris: string[]; name: string; method: string; scopes: string };

// `"MCP #{name}".truncate(NAME_MAX)`: Ruby counts characters, ActiveSupport keeps room for the omission.
function clientName(params: Record<string, unknown>): string {
  const raw = stringParam(params, "client_name");
  if (raw.includes("\0") || AMBIGUOUS_BLANK.test(raw) || /\p{Surrogate}/u.test(raw))
    throw new HandBackToRails("a client name Ruby and JavaScript read differently");
  const stripped = rubyStrip(raw);
  const name = Array.from(`MCP ${/^\p{White_Space}*$/u.test(stripped) ? "MCP client" : stripped}`);
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX - OMISSION.length).join("") + OMISSION : name.join("");
}

function validateRegistration(params: Record<string, unknown>): Registration {
  const uris = redirectUris(params);
  if (uris.length === 0) throw new RegistrationError("redirect_uris is required");
  for (const uri of uris) validateRedirectUri(uri);
  if ([...uris.join("\n")].length > REDIRECT_URIS_MAX_LENGTH)
    throw new RegistrationError(`redirect_uris must be at most ${REDIRECT_URIS_MAX_LENGTH} characters combined`);
  // OauthApplication.new evaluates its arguments in order: the name, the redirect URI, `confidential?`, then the scopes.
  const name = clientName(params);
  const given = stringParam(params, "token_endpoint_auth_method");
  if (present(given) && !TOKEN_ENDPOINT_AUTH_METHODS.includes(given))
    throw new RegistrationError("unsupported token_endpoint_auth_method");
  const requested = stringParam(params, "scope")
    .split(/[ \t\n\v\f\r]+/u)
    .filter((scope) => scope !== "");
  const chosen =
    requested.length > 0 ? [...new Set(requested.filter((scope) => MCP_SCOPES.includes(scope)))] : MCP_SCOPES;
  if (requested.length > 0 && chosen.length === 0) throw new RegistrationError("no supported scopes requested");
  return { redirectUris: uris, name, method: present(given) ? given : "none", scopes: chosen.join(" ") };
}

// Api::V2::McpController#register.
export async function register(call: ApiCall): Promise<ActionResult> {
  const invalid = (message: string) =>
    renderJson({ error: "invalid_client_metadata", error_description: message }, 400);
  const text = new TextDecoder().decode(call.rawBody);
  const source = present(text) ? text : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Rails answers "JSON parse error" for it, but its parser reads comments and rejects bytes JavaScript's does not.
    throw new HandBackToRails("a registration body that is not JSON");
  }
  const params =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  let registration: Registration;
  try {
    registration = validateRegistration(params);
  } catch (error) {
    if (error instanceof RegistrationError) return invalid(error.message);
    throw error;
  }
  // Every refusal and hand-back is above this line: from here on the row is written and the answer cannot fail.
  const confidential = registration.method !== "none";
  const created = await insertDynamicClient(
    {
      name: registration.name,
      redirectUri: registration.redirectUris.join("\n"),
      scopes: registration.scopes,
      confidential,
    },
    () => new Date(),
  );
  return renderJson(
    {
      client_id: created.uid,
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: registration.method,
      scope: registration.scopes,
      ...(confidential ? { client_secret: created.secret } : {}),
    },
    201,
  );
}
