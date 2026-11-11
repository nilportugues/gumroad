// Oauth::AuthorizationsController (app/controllers/oauth/authorizations_controller.rb over Doorkeeper 5.7.1's), on /oauth/authorize and the
// /muse, /claude, /chatgpt and /ifttt `v1/oauth2/authorize` aliases of #new, the `/:alias/v1/oauth2/authorize/:code` aliases of #show and
// Notion's `/notion/oauth2/authorize` (Oauth::Notion::AuthorizationsController: #new, with a Notion call after the sign-in check).
//
// Ported: a signed-out visit (redirect to /oauth/login), #create of a request Doorkeeper's PreAuthorization rejects (a redirect back to
// the client with `error`, or a 400/401 JSON body), and #destroy (the Deny button).
// Handed to Rails before any write:
//   - every outcome of #new but the login redirect: handle_auth_errors is :render, so errors render the error page, a layout like the
//     consent page; #destroy of a response type with no strategy renders it too;
//   - #create of a request that passes every check, which issues a grant whose code is random;
//   - #show of a signed-in visitor, which renders the layout, and any dynamically registered MCP client (extra screening);
//   - a value Node does not parse as Ruby would: anything but plain printable text in a parameter, a redirect URI that is not a plain
//     http(s) URL (custom schemes, loopback hosts, queries) or a client whose registered ones are not, and `response_mode`.
import { Prisma } from "@prisma/client";

import { withApplicationLock } from "../models/oauth-application-writes.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { cgiEscape } from "./rails-params.ts";
import { fullpath } from "./rails-request.ts";

const LOGIN_PATH = "/oauth/login";
const ROBOTS_HEADERS = { "x-robots-tag": "noindex" };
const CODE_RESPONSE_TYPE = "code";
// Doorkeeper.config.default_scopes and optional_scopes (config/initializers/doorkeeper.rb).
const DEFAULT_SCOPES = ["view_public"];
const SERVER_SCOPES = [
  ...DEFAULT_SCOPES,
  ...[
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
  ],
];
const STRATEGY_RESPONSE_TYPES = [CODE_RESPONSE_TYPE, "token"];
const PKCE_METHODS = ["plain", "S256"];
const FIELDS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "response_mode",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;
const PRINTABLE = /^[\x20-\x7e]*$/u;
// An absolute http(s) URL with no userinfo, query or fragment, and a path URI.parse takes: a RedirectUriValidator success.
const PLAIN_URI =
  /^(https?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?((?:\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*)*)$/u;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

// config/locales/en.yml of doorkeeper: doorkeeper.errors.messages.
const DESCRIPTIONS: Record<string, string> = {
  invalid_redirect_uri: "The requested redirect uri is malformed or doesn't match client redirect URI.",
  access_denied: "The resource owner or authorization server denied the request.",
  invalid_scope: "The requested scope is invalid, unknown, or malformed.",
  invalid_code_challenge_method: "The code challenge method must be plain or S256.",
  unsupported_response_type: "The authorization server does not support this response type.",
  invalid_client:
    "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
  missing_client_id: "Missing required parameter: client_id.",
};

type Fields = Partial<Record<(typeof FIELDS)[number], string>>;
export type Client = {
  id: number;
  redirect_uri: string;
  scopes: string;
  deleted_at: Date | null;
  mcp_dynamic_client: number | boolean;
};
type Failure = { name: string; description: string; redirectable: boolean; status: 400 | 401 };
export type Verdict = { failure: Failure } | { failure: null };

const blank = (value: string | undefined) => value === undefined || /^\s*$/u.test(value);

// pre_auth_params: `params.slice(...).permit(...)` keeps scalars only, so a list or hash reads as absent; Node hands those back instead.
function readFields(params: MutationInput["params"]): Fields {
  const fields: Fields = {};
  for (const name of FIELDS) {
    const value = params[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !PRINTABLE.test(value)) throw new HandBackToRails(`an unusual ${name}`);
    fields[name] = value;
  }
  if (blank(fields.response_type)) fields.response_type = CODE_RESPONSE_TYPE;
  return fields;
}

async function findClient(uid: string): Promise<Client | null> {
  const t = "oauth_applications";
  // find_by(uid:): the column's collation decides what matches.
  const [row] = await selectRows<Client>(
    Prisma.sql`SELECT ${column(t, "id")}, ${column(t, "redirect_uri")}, ${column(t, "scopes")}, ${column(t, "deleted_at")}, ${column(t, "mcp_dynamic_client")} FROM ${table(t)} WHERE ${column(t, "uid")} = ${uid} LIMIT 1`,
  );
  return row ?? null;
}

const registeredUris = (client: Client) => client.redirect_uri.split(/\s+/u).filter((uri) => uri !== "");

function plainParts(uri: string) {
  const match = PLAIN_URI.exec(uri);
  if (match === null) return null;
  const [, scheme = "", host = "", port, path = ""] = match;
  // URI::Generic#==: scheme and host compare lowercase, and an empty path is "/" on an http(s) URL.
  return {
    scheme: scheme.toLowerCase(),
    host: host.toLowerCase(),
    port: port === undefined ? DEFAULT_PORTS[scheme.toLowerCase()]! : String(Number(port)),
    path: path === "" ? "/" : path,
  };
}

// URIChecker.valid_for_authorization?, for the URLs whose comparison is plain string work. The loopback rule (ports ignored, RFC 8252)
// and queries are Ruby's IPAddr and URI, so they go to Rails.
function redirectUriMatches(requested: string, client: Client): boolean {
  const wanted = plainParts(requested);
  const registered = registeredUris(client).map((uri) => plainParts(uri));
  if (wanted === null || registered.length === 0 || registered.some((parts) => parts === null))
    throw new HandBackToRails("a redirect URI that is not a plain http(s) URL");
  if (wanted.host.startsWith("127.")) throw new HandBackToRails("a loopback redirect URI");
  return registered.some(
    (parts) =>
      parts!.scheme === wanted.scheme &&
      parts!.host === wanted.host &&
      parts!.port === wanted.port &&
      parts!.path === wanted.path,
  );
}

const fail = (
  name: string,
  redirectable: boolean,
  status: 400 | 401 = 400,
  description = DESCRIPTIONS[name]!,
): Verdict => ({ failure: { name, description, redirectable, status } });

// PreAuthorization's validations, in order, for a client that is not a dynamic one.
export function preAuthorization(fields: Fields, client: Client | null): Verdict {
  if (blank(fields.client_id)) return fail("invalid_request", false, 400, DESCRIPTIONS.missing_client_id);
  if (client === null) return fail("invalid_client", false, 401);
  if (client.mcp_dynamic_client) throw new HandBackToRails("a dynamically registered MCP client");
  if (blank(fields.redirect_uri) || !redirectUriMatches(fields.redirect_uri!, client))
    return fail("invalid_redirect_uri", false);
  if (fields.response_mode !== undefined) throw new HandBackToRails("a response_mode");
  if (fields.response_type !== CODE_RESPONSE_TYPE) return fail("unsupported_response_type", true);

  const clientScopes = client.scopes.split(/\s+/u).filter((scope) => scope !== "");
  // PreAuthorization#scope: a blank request falls back to the default scopes the client registered.
  const scope = blank(fields.scope)
    ? clientScopes.length === 0 || clientScopes.includes(DEFAULT_SCOPES[0]!)
      ? DEFAULT_SCOPES.join(" ")
      : ""
    : fields.scope!;
  const allowed = clientScopes.length === 0 ? SERVER_SCOPES : clientScopes;
  const requested = scope.split(/ +/u).filter((entry) => entry !== "");
  if (blank(scope) || !requested.every((entry) => allowed.includes(entry))) return fail("invalid_scope", true);

  if (
    !blank(fields.code_challenge) &&
    (blank(fields.code_challenge_method) || !PKCE_METHODS.includes(fields.code_challenge_method!))
  )
    return fail("invalid_code_challenge_method", true);
  return { failure: null };
}

// Rack::Utils.build_query: `URI.encode_www_form_component` on each key and value.
const wwwForm = (value: string) => cgiEscape(value).replaceAll("%2A", "*").replaceAll("~", "%7E");

// URIBuilder.uri_with_query / uri_with_fragment on a plain URL, which has neither a query nor a fragment. Blank values are dropped.
export function errorRedirect(
  redirectUri: string,
  name: string,
  description: string,
  state: string | undefined,
  onFragment: boolean,
): string {
  const pairs: [string, string][] = [
    ["error", name],
    ["error_description", description],
  ];
  if (!blank(state)) pairs.push(["state", state!]);
  return `${redirectUri}${onFragment ? "#" : "?"}${pairs.map(([key, value]) => `${wwwForm(key)}=${wwwForm(value)}`).join("&")}`;
}

const redirect = (location: string): ActionResult => ({ status: 302, location, headers: ROBOTS_HEADERS });

// #redirect_or_render of #create for the ErrorResponse a failed pre-authorization turns into.
function answer(failure: Failure, fields: Fields): ActionResult {
  if (failure.redirectable)
    return redirect(
      errorRedirect(
        fields.redirect_uri!,
        failure.name,
        failure.description,
        fields.state,
        fields.response_type === "token",
      ),
    );
  const body: Record<string, string> = { error: failure.name, error_description: failure.description };
  if (!blank(fields.state)) body.state = fields.state!;
  return { ...jsonResponse(body, failure.status), headers: ROBOTS_HEADERS };
}

// `current_user.presence || redirect_to("/oauth/login?next=...")`, the resource owner authenticator; it halts before the controller's own
// filters, so the redirect carries no X-Robots-Tag.
const signedOut = (input: MutationInput): ActionResult => ({
  status: 302,
  location: `${LOGIN_PATH}?next=${cgiEscape(fullpath(input.request))}`,
  rescued: true,
});

const ownerOrLogin = (input: MutationInput): ActionResult | null =>
  input.context.loggedInUser === null ? signedOut(input) : null;

function newAuthorization(input: MutationInput): ActionResult {
  const halted = ownerOrLogin(input);
  if (halted) return halted;
  // handle_auth_errors is :render, so every other outcome of #new is an ERB view in the application layout: the consent page or the error
  // page. #show renders the code page in it as well, and Notion's #new calls the Notion API first.
  throw new HandBackToRails("a page rendered in the application layout");
}

async function createAuthorization(input: MutationInput): Promise<ActionResult> {
  const halted = ownerOrLogin(input);
  if (halted) return halted;
  const fields = readFields(input.params);
  const evaluate = async () => {
    const verdict = preAuthorization(fields, blank(fields.client_id) ? null : await findClient(fields.client_id!));
    if (verdict.failure === null)
      throw new HandBackToRails("an authorizable request, which issues a grant with a random code");
    return answer(verdict.failure, fields);
  };
  const client = blank(fields.client_id) ? null : await findClient(fields.client_id!);
  if (client === null || client.deleted_at !== null) return evaluate();
  // #authorize_response reads the application under a shared row lock. A sweep holding it makes Rails retry and answer 503: leave that to Rails.
  const state = { locked: false };
  try {
    return await withApplicationLock(client.id, true, () => {
      state.locked = true;
      return evaluate();
    });
  } catch (error) {
    if (!state.locked && !(error instanceof HandBackToRails)) throw new HandBackToRails("a contended application row");
    throw error;
  }
}

// #destroy denies without validating anything: the redirect goes to whatever redirect_uri was sent, so only a plain URL is built here.
async function destroyAuthorization(input: MutationInput): Promise<ActionResult> {
  const halted = ownerOrLogin(input);
  if (halted) return halted;
  const fields = readFields(input.params);
  // Request.authorization_strategy finds a strategy for "code" and, through its fallback, for "token"; any other type renders the error page.
  if (!STRATEGY_RESPONSE_TYPES.includes(fields.response_type!))
    throw new HandBackToRails("a response type with no authorization strategy, which renders the error page");
  if (fields.response_mode !== undefined) throw new HandBackToRails("a response_mode");
  if (fields.redirect_uri === undefined || plainParts(fields.redirect_uri) === null)
    throw new HandBackToRails("a redirect URI that is not a plain http(s) URL");
  if (!blank(fields.client_id)) {
    const client = await findClient(fields.client_id!);
    // Building the pre-authorization validates the request against the client's URIs.
    if (client?.mcp_dynamic_client) throw new HandBackToRails("a dynamically registered MCP client");
    if (client && registeredUris(client).some((uri) => plainParts(uri) === null))
      throw new HandBackToRails("a client whose redirect URIs are not plain http(s) URLs");
  }
  return redirect(
    errorRedirect(
      fields.redirect_uri,
      "access_denied",
      DESCRIPTIONS.access_denied!,
      fields.state,
      fields.response_type === "token",
    ),
  );
}

const ALIASES = ["muse", "claude", "chatgpt", "ifttt"];
const NEW_PATTERNS = ["/oauth/authorize", "/notion/oauth2/authorize", ...ALIASES.map((client) => `/${client}/v1/oauth2/authorize`)];
const SHOW_PATTERNS = ALIASES.map((client) => `/${client}/v1/oauth2/authorize/:code`);

registerMutations(
  ...[...NEW_PATTERNS, ...SHOW_PATTERNS].map((pattern) => ({
    method: "GET",
    pattern,
    skipForgeryProtection: true,
    run: (input: MutationInput) => Promise.resolve().then(() => newAuthorization(input)),
  })),
  { method: "POST", pattern: "/oauth/authorize", run: createAuthorization },
  { method: "DELETE", pattern: "/oauth/authorize", run: destroyAuthorization },
);
