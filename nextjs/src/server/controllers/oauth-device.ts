// The browser-less half of the OAuth device flow: POST /oauth/device/code (Oauth::DeviceCodesController) and the parts of
// Oauth::DeviceAuthorizationsController that need no page, i.e. a signed-out visitor holding a pending code being sent to the login
// page with the code parked in the session, a signed-out visitor given the code form (no code, or a code that is unknown, expired,
// closed or no longer pending), and a signed-out decision being refused. The approval page and every signed-in request stay in Rails. The device-code grant of POST /oauth/token lives in oauth-tokens.ts.
import { randomBytes } from "node:crypto";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { buttonTag, escapeHtml } from "../erb/html.ts";
import { domainConfig } from "../infra/domain.ts";
import {
  createFor,
  EXPIRES_IN_SECONDS,
  findByUserCode,
  formatUserCode,
  POLL_INTERVAL_SECONDS,
  STATUS_PENDING,
  withApplicationRowLock,
} from "../models/oauth-device-authorization.ts";
import { findApplicationById, truthy } from "../models/oauth-tokens.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { renderApplicationPage } from "./erb-pages.ts";
import { jsonResponse } from "./json-seller.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import {
  authenticateOauthApplication,
  oauthJsonError,
  refusalJson,
  requestedOauthScope,
  stringParam,
  validOauthScope,
} from "./oauth-client-authentication.ts";
import { cgiEscape, requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { signedOutRefusal } from "./wishlists-mutations.ts";

const USER_CODE_HANDOFF_SESSION_KEY = "oauth_device_authorization_user_code_handoffs";
const MAX_USER_CODE_HANDOFFS = 20;
const HANDOFF_BYTES = 16;
const MAX_USER_AGENT_LENGTH = 255;
const NO_STORE = "no-store";
const NOINDEX = { "x-robots-tag": "noindex" };

type Handoffs = Map<string, unknown>;

export const requestUserAgent = (input: MutationInput): string =>
  Array.from(input.request.headers.get("user-agent") ?? "")
    .slice(0, MAX_USER_AGENT_LENGTH)
    .join("");

export function requireRemoteIp(input: MutationInput): string {
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  return ip;
}

// ---- POST /oauth/device/code

async function createDeviceCode(input: MutationInput): Promise<ActionResult> {
  const { application, refusal } = await authenticateOauthApplication(input);
  if (refusal !== null) return refusalJson(input, refusal);

  const ipAddress = requireRemoteIp(input);
  const userAgent = requestUserAgent(input);
  const now = new Date();
  // `oauth_application.with_lock`: the row is locked and reloaded, so the opt-in and the scopes are read as the lock holder sees them.
  const result = await withApplicationRowLock(application.id, async () => {
    const locked = (await findApplicationById(application.id)) ?? application;
    if (!truthy(locked.device_authorization_enabled))
      return oauthJsonError(input, "unauthorized_client", "Client is not allowed to use device authorization");
    const scopes = requestedOauthScope(input.params, locked);
    if (!validOauthScope(locked, scopes))
      return oauthJsonError(input, "invalid_scope", "The requested scope is invalid");
    return createFor({ applicationId: locked.id, scopes: scopes!, ipAddress, userAgent, now });
  });
  if ("status" in result) return result;

  const { protocol, domain } = domainConfig();
  const verificationUri = `${protocol}://${domain}/oauth/device`;
  return {
    ...jsonResponse({
      device_code: result.deviceCode,
      user_code: result.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${cgiEscape(result.userCode)}`,
      expires_in: EXPIRES_IN_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    }),
    headers: { "cache-control": NO_STORE },
  };
}

// ---- GET /oauth/device, signed out

// Integer#to_i of a session value: only the shapes JSON puts there are read, anything else raises in Rails.
function toInteger(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  throw new HandBackToRails("a device handoff with a created_at that is not a number");
}

function entryUserCode(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const code = (entry as Record<string, unknown>).user_code;
  if (code === null || code === undefined) return null;
  if (typeof code !== "string") throw new HandBackToRails("a device handoff with a user code that is not a string");
  return code;
}

function entryCreatedAt(entry: unknown): number {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? toInteger((entry as Record<string, unknown>).created_at)
    : 0;
}

// #user_code_handoffs and #pruned_user_code_handoffs
function prunedHandoffs(input: MutationInput, now: Date): Handoffs {
  const stored = input.chain.session.data[USER_CODE_HANDOFF_SESSION_KEY];
  const handoffs: Handoffs = new Map();
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return handoffs;
  const cutoff = Math.floor(now.getTime() / 1000) - EXPIRES_IN_SECONDS;
  for (const [key, entry] of Object.entries(stored)) {
    const userCode = entryUserCode(entry);
    if (entryCreatedAt(entry) >= cutoff && userCode !== null && isPresent(userCode)) handoffs.set(key, entry);
  }
  return handoffs;
}

// #sync_user_code_handoffs
function syncHandoffs(input: MutationInput, handoffs: Handoffs): void {
  if (handoffs.size === 0) Reflect.deleteProperty(input.chain.session.data, USER_CODE_HANDOFF_SESSION_KEY);
  else input.chain.session.data[USER_CODE_HANDOFF_SESSION_KEY] = Object.fromEntries(handoffs);
}

// #store_user_code_handoff. Ruby's sort_by is not stable, so a tie in created_at has no order to reproduce.
function storeHandoff(input: MutationInput, userCode: string, now: Date): string {
  const handoff = randomBytes(HANDOFF_BYTES).toString("base64url");
  const handoffs = prunedHandoffs(input, now);
  for (const [key, entry] of handoffs) if (entryUserCode(entry) === userCode) handoffs.delete(key);
  handoffs.set(handoff, { user_code: userCode, created_at: Math.floor(now.getTime() / 1000) });
  const sorted = [...handoffs].sort(([, a], [, b]) => entryCreatedAt(a) - entryCreatedAt(b));
  const times = sorted.map(([, entry]) => entryCreatedAt(entry));
  if (new Set(times).size !== times.length) throw new HandBackToRails("device handoffs created in the same second");
  input.chain.session.data[USER_CODE_HANDOFF_SESSION_KEY] = Object.fromEntries(sorted.slice(-MAX_USER_CODE_HANDOFFS));
  return handoff;
}

const INVALID_CODE = "This code is invalid.";
const EXPIRED_CODE = "This code has expired.";
const INVALID_OR_EXPIRED_CODE = "This code is invalid or expired.";
const FIELD_CLASS = "w-full rounded border border-border bg-background p-3";
const CONTINUE_CLASS =
  "inline-flex items-center justify-center gap-2 cursor-pointer border border-border rounded font-[inherit] no-underline transition-transform hover:-translate-1 hover:shadow active:translate-0 active:shadow-none disabled:opacity-30 disabled:hover:translate-0 disabled:hover:shadow-none bg-accent-with-text text-accent-foreground px-4 py-3 text-base leading-snug";

// The `else` branch of app/views/oauth/device_authorizations/new.html.erb, which is what a signed-out visitor sees whenever no
// approvable code was found. Under `hide_layouts`, with `X-Robots-Tag: noindex`.
function codeFormView(userCode: string, errorMessage: string | null): string {
  const error = errorMessage === null ? "" : `        <p>${escapeHtml(errorMessage)}</p>\n`;
  const button = buttonTag("Continue", { type: "submit", class: CONTINUE_CLASS }).value;
  return `<main class="grid divide-y divide-border bg-background border border-border rounded mx-auto my-8 h-min max-w-md w-[calc(100%-2rem)]">
    <header class="flex flex-col gap-4 p-4 text-center">
      <h2>Enter device code</h2>
      <p>Paste the code shown by the application requesting access.</p>
    </header>
    <div class="flex flex-col gap-4 p-4">
${error}      <form class="flex flex-col gap-4" action="/oauth/device" accept-charset="UTF-8" method="get">
        <input type="text" name="user_code" id="user_code" value="${escapeHtml(userCode)}" autofocus="autofocus" placeholder="GRD-ABCD-1234" class="${FIELD_CLASS}" />
        ${button}
</form>    </div>
</main>

`;
}

function codeFormPage(input: MutationInput, userCode: string, errorMessage: string | null): Promise<ActionResult> {
  return renderApplicationPage(input.request, input, null, () => codeFormView(userCode, errorMessage), {
    hideBase: true,
    analyticsFirst: false,
    handBackFlash: true,
    headers: NOINDEX,
  });
}

async function showDeviceAuthorization(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) !== null) throw new HandBackToRails("a signed-in device authorization page");
  if (requestFormat(input.request) !== "html")
    throw new HandBackToRails("a device authorization page in another format");
  const now = new Date();

  let rawUserCode = stringParam(input.params, "user_code");
  if (!isPresent(rawUserCode)) {
    const handoff = stringParam(input.params, "handoff");
    rawUserCode = null;
    if (isPresent(handoff)) {
      const handoffs = prunedHandoffs(input, now);
      syncHandoffs(input, handoffs);
      rawUserCode = entryUserCode(handoffs.get(handoff));
    }
  }
  const userCode = formatUserCode(rawUserCode ?? "");
  // Every other outcome renders the page, with the reason in it.
  if (userCode === "") return codeFormPage(input, userCode, null);
  const authorization = await findByUserCode(userCode);
  if (authorization === null) return codeFormPage(input, userCode, INVALID_CODE);
  const application = await findApplicationById(authorization.oauth_application_id);
  if (application === null || application.deleted_at !== null || !truthy(application.device_authorization_enabled))
    return codeFormPage(input, userCode, INVALID_CODE);
  if (authorization.expires_at.getTime() <= now.getTime()) return codeFormPage(input, userCode, EXPIRED_CODE);
  // A signed-out visitor owns no terminal authorization, so any other status is refused like an unknown code.
  if (authorization.status !== STATUS_PENDING) return codeFormPage(input, userCode, INVALID_OR_EXPIRED_CODE);

  const handoff = storeHandoff(input, userCode, now);
  return {
    status: 302,
    location: `/login?next=${cgiEscape(`/oauth/device?handoff=${handoff}`)}`,
    headers: NOINDEX,
  };
}

// ---- POST /oauth/device

async function decideDeviceAuthorization(input: MutationInput): Promise<ActionResult> {
  const signedOut = signedOutRefusal(input);
  if (signedOut === null) throw new HandBackToRails("a signed-in device authorization decision");
  return { ...signedOut, headers: { ...("headers" in signedOut ? signedOut.headers : {}), ...NOINDEX } };
}

registerMutations(
  {
    method: "POST",
    pattern: "/oauth/device/code",
    skipForgeryProtection: true,
    formats: ["any"],
    run: createDeviceCode,
  },
  { method: "GET", pattern: "/oauth/device", skipForgeryProtection: true, run: showDeviceAuthorization },
  { method: "POST", pattern: "/oauth/device", formats: ["html", "json"], run: decideDeviceAuthorization },
);
