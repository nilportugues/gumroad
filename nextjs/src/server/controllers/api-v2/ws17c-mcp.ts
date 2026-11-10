// Api::V2::McpController (the /muse, /claude and /chatgpt connector paths and the `.well-known` documents) and
// Api::V2::NotionUnfurlUrlsController. The JSON-RPC envelope and tools/list are ported (../../mcp/server.ts); a tool call runs here only for the bodies in mcp/tool-bodies.ts,
// dynamic client registration and the product preview of the Notion unfurl stay in Rails.
import { domainConfig } from "../../page-props/domain.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { isFeatureEnabled } from "../../infra/flipper.ts";
import { METHOD_HEADER, MCP_PROTOCOL_FLAG, NAME_HEADER, VERSION_HEADER } from "../../mcp/constants.ts";
import { recordProtocolTelemetry } from "../../mcp/protocol-telemetry.ts";
import { RpcSession, rpcHttpStatus } from "../../mcp/server.ts";
import { head, renderJson, type ApiCall } from "./ws17c-base.ts";

// Mcp::OauthClientRegistration::MCP_SCOPES
const MCP_SCOPES = ["view_public", "view_profile", "view_sales", "edit_products", "view_payouts", "account"];
// Doorkeeper.configuration.public_scopes
const PUBLIC_SCOPES = ["edit_products", "edit_emails", "view_sales", "mark_sales_as_shipped", "edit_sales", "revenue_share", "ifttt", "view_profile", "edit_profile", "view_payouts", "view_tax_data", "account"];

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
  return renderJson({ resource: `${base}${path}`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: MCP_SCOPES });
}

// RFC 6750 challenge: `Bearer realm="Gumroad", scope="...", resource_metadata="..."`.
export const bearerChallenge = (path: string) => `Bearer realm="Gumroad", scope="${MCP_SCOPES.join(" ")}", resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource${path}"`;

// The 401 of McpController: Doorkeeper's headers with its own WWW-Authenticate.
export const mcpUnauthorized = (path: string, headers: Record<string, string>) =>
  head(401, { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "WWW-Authenticate")), "WWW-Authenticate": bearerChallenge(path) });

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

export const MCP_AUTHORIZE_SCOPES = [...PUBLIC_SCOPES, "view_public"];

// Api::V2::McpController#mcp. mcpPreAuth has checked that a POST body is JSON.
export async function mcp(call: ApiCall): Promise<ActionResult> {
  if (call.request.method === "GET") return head(405, { Allow: "POST" }, false);
  if (call.request.method !== "POST") throw new HandBackToRails("an MCP request with a method other than GET or POST");
  const text = new TextDecoder().decode(call.rawBody);
  // A fraction, an exponent or an integer past 2^53 would not survive JSON.parse as Ruby reads it; Rails answers those.
  // Only numbers matter: the "2.0" of `"jsonrpc":"2.0"` and any other string literal is blanked first.
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  if (/\d\.\d|\d[eE][+-]?\d|\d{16}/u.test(withoutStrings)) throw new HandBackToRails("an MCP body with a number JavaScript cannot read exactly");
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
  const reply = await session.handle(JSON.parse(text));
  // A tool call that hands back leaves before this point, so Rails records its own requests.
  await recordProtocolTelemetry(connector, session.counts);
  if (reply === null) return head(202, {}, false);
  return renderJson(reply, rpcHttpStatus(reply, session.protocolEra));
}

export const NOTION_UNAUTHORIZED = { error: { status: 401, message: "Request need to be authorized. Required parameter for authorizing request is missing or invalid." } };

export async function notionUnfurl(call: ApiCall): Promise<ActionResult> {
  const uri = call.params.uri;
  if (uri === undefined || uri === null || (typeof uri === "string" && uri.trim() === "")) return { ...renderJson({ error: { status: 404, message: "Product not found" } }, 404), rescued: true };
  // The product preview (rating counts, formatted price, cover image) is built by Rails.
  throw new HandBackToRails("a Notion link preview");
}

export const renderUnauthorized = () => renderJson(NOTION_UNAUTHORIZED, 401);

// DELETE /notion/unfurl: nothing to unfurl, nothing to authorize.
export const notionUnfurlDestroy = async (): Promise<ActionResult> => head(200, {}, false);
