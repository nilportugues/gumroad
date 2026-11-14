// McpConnectorsController#index and #show: /mcp and the five connector pages. The markup is app/views/mcp_connectors/*.html.erb, read from the
// files; the table below is every Ruby expression, condition and loop in them.
import { button, homeHelpers, type LayoutContext } from "../erb/home-layout.ts";
import { linkTo, SafeString } from "../erb/html.ts";
import { type ErbTable, renderErb, type Scope } from "../erb/template.ts";
import { domainConfig } from "../page-props/domain.ts";

import { type ActionContext, type Rendered, RoutingError } from "./application-controller.ts";
import { type PageMeta, renderHomePage } from "./erb-pages.ts";
import type { RailsRequest } from "./rails-request.ts";

// McpConnectorsController::CLIENTS
type McpClient = {
  label: string;
  pendingReview?: boolean;
  directoryUrl?: string;
  directoryName?: string;
  listingNotice?: string;
  connectLabel?: string;
  setup: string;
  availability: string;
};
const MCP_CLIENTS: Record<string, McpClient> = {
  muse: {
    label: "Muse",
    pendingReview: true,
    setup:
      "Add a remote MCP server in your client using the URL below. Choose OAuth when the client requests an authentication method.",
    availability: "Submitted for review. The Gumroad connector is not yet available in Muse.",
  },
  claude: {
    label: "Claude",
    directoryUrl: "https://claude.ai/directory/gumroad",
    listingNotice: "Listed in Claude’s connector directory. You can also add it as a custom connector.",
    connectLabel: "Add Gumroad to Claude",
    setup:
      "Open Gumroad in Claude’s connector directory and connect it. Or open Settings > Connectors in Claude, choose Add custom connector, and enter the URL below. If you cannot add connectors, ask your organization administrator.",
    availability:
      "Add Gumroad from Claude’s connector directory. On Team and Enterprise plans, your organization’s settings control which connectors you can add.",
  },
  cursor: {
    label: "Cursor",
    connectLabel: "Add Gumroad to Cursor",
    setup:
      "Add a remote MCP server in Cursor using the URL below. If Cursor asks you to sign in, approve the access in Gumroad.",
    availability:
      "Available today as a custom remote MCP server. There is no published Gumroad listing in Cursor’s directory yet.",
  },
  antigravity: {
    label: "Google Antigravity",
    connectLabel: "Add Gumroad to Antigravity",
    setup:
      "Add a remote MCP server in Antigravity using the URL below. If Antigravity asks you to sign in, approve the access in Gumroad.",
    availability:
      "Available today as a custom remote MCP server. There is no published Gumroad listing in Antigravity’s directory yet.",
  },
  chatgpt: {
    label: "ChatGPT",
    directoryUrl: "https://chatgpt.com/plugins/plugin_asdk_app_6adf8e8e7eac8191a9af1b87fdeedb45",
    directoryName: "plugin directory",
    listingNotice: "Listed in ChatGPT’s plugin directory.",
    connectLabel: "Add Gumroad to ChatGPT",
    setup:
      "Open Gumroad in ChatGPT’s plugin directory and connect it. If you cannot add plugins, ask your workspace administrator.",
    availability: "Add Gumroad from ChatGPT’s plugin directory.",
  },
};
const HELP_ARTICLE_PATH = "355-connect-ai-assistants-to-gumroad";
const SETUP_GUIDE_URL = `https://gumroad.com/help/article/${HELP_ARTICLE_PATH}`;
const LINK_CLASS = "inline-flex min-h-11 items-center underline underline-offset-4";
const BLOCK_LINK_CLASS = "block underline underline-offset-4";

const clientOf = (scope: Scope) => scope.client as McpClient;

function mcpTable({ config }: LayoutContext, clientKey: string | null): ErbTable {
  const origin = `${config.protocol}://${config.domain}`;
  const selected = clientKey === null ? undefined : MCP_CLIENTS[clientKey];
  const entries = (except?: string) =>
    Object.entries(MCP_CLIENTS)
      .filter(([key]) => key !== except)
      .map(([key, client]) => ({ key, client }));
  const link = (text: string, target: string) => linkTo(text, target, { class: LINK_CLASS });
  const helpers = homeHelpers(config);
  helpers["McpConnectorsController::SETUP_GUIDE_URL"] = () => SETUP_GUIDE_URL;
  return {
    helpers,
    statements: {
      "client_name = @client[:label]": (scope) => void (scope.client_name = selected?.label),
      "pending_review = @client[:pending_review]": (scope) =>
        void (scope.pending_review = selected?.pendingReview === true),
    },
    conditions: {
      "client[:pending_review]": (scope) => clientOf(scope).pendingReview === true,
      "client[:listing_notice]": (scope) => clientOf(scope).listingNotice !== undefined,
      pending_review: (scope) => scope.pending_review === true,
      "@client[:listing_notice]": () => selected?.listingNotice !== undefined,
      "@client[:directory_url]": () => selected?.directoryUrl !== undefined,
    },
    loops: {
      "McpConnectorsController::CLIENTS.each do |key, client|": () => entries(),
      "McpConnectorsController::CLIENTS.reject { |_key, client| client[:pending_review] }.each do |key, client|": () =>
        entries().filter(({ client }) => client.pendingReview !== true),
      "McpConnectorsController::CLIENTS.except(@client_key).each do |key, client|": () =>
        entries(clientKey ?? undefined),
    },
    values: {
      "client[:label]": (scope) => clientOf(scope).label,
      'client[:directory_url] ? "Available now in #{client[:label]}’s #{client[:directory_name] || "connector directory"}." : "Available now as a custom connector."':
        (scope) =>
          clientOf(scope).directoryUrl
            ? `Available now in ${clientOf(scope).label}’s ${clientOf(scope).directoryName ?? "connector directory"}.`
            : "Available now as a custom connector.",
      "client[:listing_notice]": (scope) => clientOf(scope).listingNotice ?? "",
      'link_to client[:pending_review] ? "Read the technical details" : "Set up Gumroad MCP", "/#{key}", class: "inline-flex min-h-11 items-center underline underline-offset-4"':
        (scope) =>
          link(
            clientOf(scope).pendingReview ? "Read the technical details" : "Set up Gumroad MCP",
            `/${String(scope.key)}`,
          ),
      'link_to "Gumroad MCP for #{client[:label]} connector page", "/#{key}", class: "block text-lg underline underline-offset-4"':
        (scope) =>
          linkTo(`Gumroad MCP for ${clientOf(scope).label} connector page`, `/${String(scope.key)}`, {
            class: "block text-lg underline underline-offset-4",
          }),
      'link_to "Connecting AI assistants to your Gumroad store", McpConnectorsController::SETUP_GUIDE_URL, class: "block text-lg underline underline-offset-4"':
        () =>
          linkTo("Connecting AI assistants to your Gumroad store", SETUP_GUIDE_URL, {
            class: "block text-lg underline underline-offset-4",
          }),
      'link_to "Gumroad MCP for #{client[:label]}", "/#{key}", class: "inline-flex min-h-11 items-center underline underline-offset-4"':
        (scope) => link(`Gumroad MCP for ${clientOf(scope).label}`, `/${String(scope.key)}`),
      client_name: (scope) => String(scope.client_name),
      "@client[:listing_notice]": () => selected?.listingNotice ?? "",
      "@client[:availability]": () => selected?.availability ?? "",
      "@client[:setup]": () => selected?.setup ?? "",
      'pending_review ? "What does the connector support?" : "What can you do with #{client_name}?"': (scope) =>
        scope.pending_review
          ? "What does the connector support?"
          : `What can you do with ${String(scope.client_name)}?`,
      'pending_review ? "For connector reviewers" : "Set up Gumroad MCP"': (scope) =>
        scope.pending_review ? "For connector reviewers" : "Set up Gumroad MCP",
      'pending_review ? "Technical details" : "How do you connect #{client_name}?"': (scope) =>
        scope.pending_review ? "Technical details" : `How do you connect ${String(scope.client_name)}?`,
      'render "home/shared/button", text: pending_review ? "View technical details" : (@client[:connect_label] || "Connect your store"), url: @client[:directory_url] || "#connect", variant: "dark"':
        (scope) =>
          new SafeString(
            button({
              text: scope.pending_review ? "View technical details" : (selected?.connectLabel ?? "Connect your store"),
              url: selected?.directoryUrl ?? "#connect",
              variant: "dark",
            }),
          ),
      '"#{PROTOCOL}://#{DOMAIN}/muse/v1/mcp"': () => `${origin}/muse/v1/mcp`,
      '"#{PROTOCOL}://#{DOMAIN}/#{@client_key}/v1/mcp"': () => `${origin}/${clientKey}/v1/mcp`,
      'link_to "Gumroad in #{@client[:label]}’s #{@client[:directory_name] || "connector directory"}", @client[:directory_url], class: "block text-lg underline underline-offset-4"':
        () =>
          linkTo(
            `Gumroad in ${selected?.label ?? ""}’s ${selected?.directoryName ?? "connector directory"}`,
            selected?.directoryUrl ?? "",
            {
              class: "block text-lg underline underline-offset-4",
            },
          ),
      'link_to "OAuth server metadata", "/.well-known/oauth-authorization-server", class: "block underline underline-offset-4"':
        () => linkTo("OAuth server metadata", "/.well-known/oauth-authorization-server", { class: BLOCK_LINK_CLASS }),
      'link_to "MCP discovery", "/.well-known/mcp.json", class: "block underline underline-offset-4"': () =>
        linkTo("MCP discovery", "/.well-known/mcp.json", { class: BLOCK_LINK_CLASS }),
      'link_to "All connectors", mcp_path, class: "inline-flex min-h-11 items-center underline underline-offset-4"':
        () => link("All connectors", "/mcp"),
      'link_to "Setup guide", McpConnectorsController::SETUP_GUIDE_URL, class: "inline-flex min-h-11 items-center underline underline-offset-4"':
        () => link("Setup guide", SETUP_GUIDE_URL),
      'link_to "API docs", "/api", class: "inline-flex min-h-11 items-center underline underline-offset-4"': () =>
        link("API docs", "/api"),
      'link_to "MCP discovery", "/.well-known/mcp.json", class: "inline-flex min-h-11 items-center underline underline-offset-4"':
        () => link("MCP discovery", "/.well-known/mcp.json"),
    },
  };
}

function mcpMeta(clientKey: string | null, origin: string): PageMeta {
  if (clientKey === null) {
    return {
      title: "Gumroad MCP | Sell digital products from your AI assistant",
      description:
        "Connect your Gumroad store to an AI assistant with Model Context Protocol. List sales, draft products, publish them, and check payouts from your chat.",
      url: `${origin}/mcp`,
    };
  }
  const client = MCP_CLIENTS[clientKey]!;
  return {
    title: `Gumroad MCP for ${client.label} | Sell digital products`,
    description: client.pendingReview
      ? "The Gumroad connector is submitted for review and is not yet available in Muse. Read the MCP endpoint and OAuth details."
      : `Connect ${client.label} to Gumroad with MCP. Create digital product drafts, publish products, check sales, and track payouts from your AI chat.`,
    url: `${origin}/${clientKey}`,
  };
}

// `clientKey` is null for #index.
export function mcpConnectorPage(
  request: RailsRequest,
  action: ActionContext,
  clientKey: string | null,
): Promise<Rendered> {
  if (clientKey !== null && MCP_CLIENTS[clientKey] === undefined) throw new RoutingError("Not Found");
  const config = domainConfig(process.env);
  return renderHomePage(
    request,
    action,
    // PROTOCOL://DOMAIN, not the request's own host.
    mcpMeta(clientKey, `${config.protocol}://${config.domain}`),
    (ctx) =>
      renderErb(
        clientKey === null ? "mcp_connectors/index.html.erb" : "mcp_connectors/show.html.erb",
        mcpTable(ctx, clientKey),
      ),
  );
}
