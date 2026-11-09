// WS-17c: the v2 API routes of users, emails, workflows and their emails, pages, UTM links and help articles, plus the aliases that share the
// controllers (`/ifttt`, `/muse`, `/claude`, `/chatgpt`, `/.well-known`, `/notion`), registered with the dispatcher in ./base.ts.
import { PUBLIC_READ_SCOPES, registerApiV2, type ApiV2Route } from "./base.ts";
import * as emails from "./ws17c-emails.ts";
import * as helpArticles from "./ws17c-help-articles.ts";
import * as mcp from "./ws17c-mcp.ts";
import * as pages from "./ws17c-pages.ts";
import * as users from "./ws17c-users.ts";
import * as utmLinks from "./ws17c-utm-links.ts";
import * as workflows from "./ws17c-workflows.ts";

const EDIT_EMAILS = ["edit_emails"];
const EDIT_PRODUCTS = ["edit_products"];
const EDIT_PROFILE = ["edit_profile"];

type Spec = Omit<ApiV2Route, "method" | "pattern" | "scopes" | "run"> & { scopes?: string[] };
const route = (method: string) => (pattern: string, run: ApiV2Route["run"], spec: Spec = {}): ApiV2Route => ({ method, pattern, scopes: PUBLIC_READ_SCOPES, run, ...spec });
const get = route("GET");
const post = route("POST");
const put = route("PUT");
const patch = route("PATCH");
const del = route("DELETE");

// `is_ifttt: true` is a route default of GET /ifttt/v1/user/info.
const iftttUserInfo: ApiV2Route["run"] = (input) => users.show({ ...input, params: { ...input.params, is_ifttt: true } });

const connector = (client: string): ApiV2Route[] => [
  get(`/${client}/v1/status`, mcp.status, { anonymous: true }),
  ...(["GET", "POST"] as const).map((method) =>
    route(method)(`/${client}/v1/mcp`, mcp.mcp, {
      scopes: mcp.MCP_AUTHORIZE_SCOPES,
      keepSession: true,
      rawJsonBody: true,
      preAuth: mcp.mcpPreAuth,
      unauthorized: (headers) => mcp.mcpUnauthorized(`/${client}/v1/mcp`, headers),
    }),
  ),
];

registerApiV2(
  get("/v2/user", users.show),
  get("/v2/user/theme", users.theme),
  get("/v2/user/profile_layout", users.profileLayout, { scopes: ["view_profile"], requireScope: ["view_profile"] }),
  put("/v2/user", users.update, { scopes: EDIT_PROFILE }),
  patch("/v2/user", users.update, { scopes: EDIT_PROFILE }),
  get("/v2/user/custom_html", users.customHtml),
  put("/v2/user/custom_html", users.updateCustomHtml, { scopes: EDIT_PROFILE }),
  patch("/v2/user/custom_html", users.updateCustomHtml, { scopes: EDIT_PROFILE }),
  post("/v2/user/custom_html/edit", users.editCustomHtml, { scopes: EDIT_PROFILE }),
  post("/v2/user/preview_custom_html", users.previewCustomHtml, { scopes: EDIT_PROFILE }),
  get("/ifttt/v1/status", users.iftttStatus, { anonymous: true }),
  get("/ifttt/v1/user/info", iftttUserInfo),
  post("/ifttt/v1/triggers/sale", users.iftttSaleTrigger),

  get("/v2/utm_links", utmLinks.index),
  post("/v2/utm_links", utmLinks.create, { scopes: EDIT_PRODUCTS }),
  get("/v2/utm_links/:id", utmLinks.show),
  patch("/v2/utm_links/:id", utmLinks.update, { scopes: EDIT_PRODUCTS }),
  put("/v2/utm_links/:id", utmLinks.update, { scopes: EDIT_PRODUCTS }),
  del("/v2/utm_links/:id", utmLinks.destroy, { scopes: EDIT_PRODUCTS }),
  put("/v2/utm_links/:id/disable", utmLinks.disable, { scopes: EDIT_PRODUCTS }),
  put("/v2/utm_links/:id/enable", utmLinks.enable, { scopes: EDIT_PRODUCTS }),

  post("/v2/emails/:id/preview", emails.preview, { scopes: EDIT_EMAILS }),
  post("/v2/emails/:id/send", emails.sendEmail, { scopes: EDIT_EMAILS }),
  post("/v2/emails/:id/schedule", emails.schedule, { scopes: EDIT_EMAILS }),
  post("/v2/emails/:id/unschedule", emails.unschedule, { scopes: EDIT_EMAILS }),
  get("/v2/emails", emails.index, { scopes: EDIT_EMAILS }),
  post("/v2/emails", emails.create, { scopes: EDIT_EMAILS }),
  get("/v2/emails/:id", emails.show, { scopes: EDIT_EMAILS }),
  del("/v2/emails/:id", emails.destroy, { scopes: EDIT_EMAILS }),

  get("/v2/workflows", workflows.index, { scopes: EDIT_EMAILS }),
  get("/v2/workflows/:id", workflows.show, { scopes: EDIT_EMAILS }),
  post("/v2/workflows/:workflow_id/emails", workflows.createEmail, { scopes: EDIT_EMAILS }),
  put("/v2/workflows/:workflow_id/emails/:email_id", workflows.updateEmail, { scopes: EDIT_EMAILS }),

  get("/v2/pages", pages.index),
  get("/v2/pages/:id", pages.show),
  post("/v2/pages", pages.create, { scopes: EDIT_PROFILE, requireScope: EDIT_PROFILE }),
  patch("/v2/pages/:id", pages.update, { scopes: EDIT_PROFILE, requireScope: EDIT_PROFILE }),
  put("/v2/pages/:id", pages.update, { scopes: EDIT_PROFILE, requireScope: EDIT_PROFILE }),
  del("/v2/pages/:id", pages.destroy, { scopes: EDIT_PROFILE, requireScope: EDIT_PROFILE }),

  get("/v2/help/articles", helpArticles.index),
  get("/v2/help/articles/:slug", helpArticles.show),

  ...["muse", "claude", "chatgpt"].flatMap(connector),
  get("/.well-known/mcp.json", mcp.mcpDiscovery, { anonymous: true }),
  get("/.well-known/openai-apps-challenge", mcp.openaiAppsChallenge, { anonymous: true }),
  get("/.well-known/oauth-authorization-server", mcp.oauthMetadata, { anonymous: true }),
  get("/.well-known/oauth-protected-resource", mcp.protectedResourceMetadata, { anonymous: true }),
  get("/.well-known/oauth-protected-resource/*resource_path", mcp.protectedResourceMetadata, { anonymous: true }),
  post("/notion/unfurl", mcp.notionUnfurl, {
    scopes: ["unfurl"],
    keepSession: true,
    unauthorized: (headers) => ({ ...mcp.renderUnauthorized(), headers }),
  }),
  del("/notion/unfurl", mcp.notionUnfurlDestroy, { anonymous: true, keepSession: true }),
);
