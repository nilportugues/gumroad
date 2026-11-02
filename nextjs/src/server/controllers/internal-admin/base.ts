// Api::Internal::Admin::BaseController: bearer-token authentication (AdminApiToken), the per-controller token scope, the usage stamp
// and the audit trail every write leaves (record_admin_write). Handlers receive an `AdminRequest` and answer with a `Rendered`.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { NotPortedError } from "../../models/user.ts";
import { gumroadAdminId } from "../../models/credit-creation.ts";
import { esJson, type JsonValue } from "../../search/es-json.ts";
import { HandBackToRails, type Rendered } from "../application-controller.ts";
import type { Params } from "../rails-body.ts";
import type { RailsRequest } from "../rails-request.ts";

export const ADMIN_SCOPE = "admin";
export const PIRACY_SCOPE = "piracy";
const HUMAN_TOKEN_TTL_MS = 30 * 86_400_000;
const HUMAN_TOKEN_MAX_AGE_MS = 90 * 86_400_000;
const INTERNAL_SERVER_ERROR = 500;
const JSON_TYPE = "application/json; charset=utf-8";

export type AdminActor = { id: bigint; external_id: string | null; name: string | null; email: string | null };
export type AdminToken = { id: bigint; external_id: string; actor_user_id: bigint; scope: string; expires_at: Date | null; created_at: Date; legacy: boolean };

export type AdminRequest = {
  request: RailsRequest;
  url: URL;
  // request.parameters: path parameters over the body over the query string.
  params: Params;
  // request.request_parameters: just the body.
  bodyParams: Params;
  routeParams: Record<string, string>;
  // The Content-Type the body arrived with (ParamsWrapper only wraps JSON).
  contentType: string | null;
  admin: { actor: AdminActor; token: AdminToken };
};

export const jsonRendered = (value: unknown, status = 200): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE });
export const failure = (message: string, status: number): Rendered => jsonRendered({ success: false, message }, status);
// ActiveSupport::TimeWithZone#as_json (time_precision 0)
export const timeJson = (time: Date | null | undefined): string | null => (time ? `${time.toISOString().slice(0, 19)}Z` : null);
export const hashToken = (plaintext: string): string => createHash("sha256").update(plaintext).digest("hex");
const BLANK_STRING = /^\p{White_Space}*$/u;
// Object#blank?
export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === false || (typeof value === "string" && BLANK_STRING.test(value)) || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

// A response a before_action rendered: the chain halts, so the after_actions (the XSRF-TOKEN cookie) do not run.
export const halted = (rendered: Rendered): Rendered => ({ ...rendered, rescued: true });

// Ruby 3.4's #inspect for what a parsed request can hold.
function rubyInspect(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(rubyInspect).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)} => ${rubyInspect(inner)}`).join(", ")}}`;
  return String(value);
}

// `params[...].to_s` for a value a client sent: strings as they are, nil as "", integers and booleans as Ruby prints them, a nested
// hash or array as its inspect (text no stored value equals, which is what the callers rely on). A float is stringified in ways
// Node does not model.
export function paramToS(value: unknown, source: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) return String(value);
  if (typeof value === "object") return rubyInspect(value);
  throw new NotPortedError("a parameter that is not a string", source);
}

export type AuthOutcome = { refusal: Rendered } | { token: AdminToken; actor: AdminActor };

const secureCompare = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// verify_authorization_header!, authorize_admin_token!: AdminApiToken.authenticate and the scope the controller accepts.
export async function authenticateAdmin(request: RailsRequest, requiredScope: string = ADMIN_SCOPE): Promise<AuthOutcome> {
  const header = request.headers.get("authorization");
  if (header === null) return { refusal: failure("unauthenticated", 401) };
  const plaintext = /^Bearer ([^\n]+)$/u.exec(header)?.[1];
  const invalid = { refusal: failure("authorization is invalid", 401) };
  if (plaintext === undefined || plaintext === "") return invalid;
  const digest = hashToken(plaintext);
  const row = await db.adminApiToken.findFirst({ where: { token_hash: digest }, include: { actor_user: { select: { id: true, external_id: true, name: true, email: true } } } });
  if (row === null || !secureCompare(row.token_hash, digest)) return invalid;
  if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at.getTime() <= Date.now())) return invalid;
  if (row.scope !== requiredScope) return { refusal: failure("token scope does not allow this endpoint", 403) };
  const legacy = await db.adminApiToken.findFirst({ where: { actor_user_id: BigInt(gumroadAdminId() as number) }, orderBy: { id: "asc" }, select: { id: true } });
  const token: AdminToken = { id: row.id, external_id: row.external_id, actor_user_id: row.actor_user_id, scope: row.scope, expires_at: row.expires_at, created_at: row.created_at, legacy: legacy !== null && legacy.id === row.id };
  return { token, actor: row.actor_user };
}

// AdminApiToken#record_used!: a human token's expiry slides forward, capped at 90 days from its creation.
export async function recordTokenUse(token: AdminToken): Promise<void> {
  const usedAt = new Date();
  const data: Prisma.AdminApiTokenUpdateInput = { last_used_at: usedAt };
  if (token.expires_at !== null) data.expires_at = new Date(Math.min(usedAt.getTime() + HUMAN_TOKEN_TTL_MS, token.created_at.getTime() + HUMAN_TOKEN_MAX_AGE_MS));
  await db.adminApiToken.update({ where: { id: token.id }, data });
}

// require_per_actor_token!
export const requirePerActorToken = (admin: AdminRequest["admin"]): Rendered | null => (admin.token.legacy ? failure("per-actor admin token is required", 401) : null);

export const serializeAdminActor = (actor: AdminActor) => ({ external_id: actor.external_id, name: isBlank(actor.name) ? actor.email : actor.name, email: actor.email });
export const serializeAdminToken = (token: AdminToken) => ({ external_id: token.external_id, expires_at: timeJson(token.expires_at) });

const REDACTED_PARAM_PATTERN = /password|secret|token|two_factor|otp|webhook_url|license_key|email/iu;
const ACTION_REDACTED_PARAM_KEYS: Record<string, string[]> = {
  "purchases.reassign": ["from", "to"],
  "piracy_reports.counter_notice": ["body"],
  "url_redirects.grant_download": ["id"],
  "url_redirects.revoke_download": ["id"],
  "low_balance_probation_recoveries.execute": ["snapshot"],
};
const ACTION_UNREDACTED_PARAM_KEYS: Record<string, string[]> = {
  "sendgrid_emails.remove_suppression": ["email"],
  "stranded_buyers.recover": ["email"],
  "stripe_restraint_notices.create": ["firm_email"],
};
const ACTIONS_ALLOWING_NULL_TARGET = new Set([
  "low_balance_probation_recoveries.execute",
  "low_balance_probation_recoveries.preview",
  "products.file_download_url",
  "products.hold_sales",
  "products.release_sales_hold",
  "purchases.reassign",
  "purchases.resend_all_receipts",
  "sendgrid_emails.remove_suppression",
  "stranded_buyers.recover",
]);

function redactedValue(value: unknown, key: string | null, action: string): unknown {
  const keepsValue = key !== null && (ACTION_UNREDACTED_PARAM_KEYS[action] ?? []).includes(key);
  if (key !== null && !keepsValue && (REDACTED_PARAM_PATTERN.test(key) || (ACTION_REDACTED_PARAM_KEYS[action] ?? []).includes(key))) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactedValue(item, key, action));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([nested, inner]) => [nested, redactedValue(inner, nested, action)]));
  return value;
}

// ActionController::ParamsWrapper: a JSON body is also copied under the controller's name, restricted to the attributes of the model
// of that name (`model`, a Prisma model) when there is one.
export type ParamsWrapper = { key: string; model?: string };

function modelAttributes(model: string): string[] {
  const found = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === model);
  if (found === undefined) throw new Error(`unknown model ${model}`);
  return found.fields.filter((field) => field.kind === "scalar" || field.kind === "enum").map((field) => field.name);
}

function wrappedParams(admin: AdminRequest, wrapper: ParamsWrapper | undefined): Params {
  const params = { ...admin.params };
  if (wrapper === undefined || (admin.contentType ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json" || wrapper.key in params) return params;
  const attributes = wrapper.model === undefined ? null : modelAttributes(wrapper.model);
  const body: Params = {};
  for (const [name, value] of Object.entries(admin.bodyParams)) {
    if (["authenticity_token", "_method", "utf8"].includes(name)) continue;
    if (attributes === null || attributes.includes(name)) body[name] = value;
  }
  return { ...params, [wrapper.key]: body };
}

export type AuditTarget = { type: string; id: bigint | null; externalId: string | null } | null;

// record_admin_write: the audit row is written once the block has finished (the 500 of a raised error included).
// `target` may be a function for a record the block saves (the audit row names its id once the block is done).
export async function recordAdminWrite(admin: AdminRequest, options: { action: string; target: AuditTarget | (() => AuditTarget); wrapper?: ParamsWrapper }, block: () => Promise<Rendered>): Promise<Rendered> {
  if (options.target === null && !ACTIONS_ALLOWING_NULL_TARGET.has(options.action)) throw new Error(`admin write audit target is required for ${options.action}`);
  let rendered: Rendered | null = null;
  let error: Error | null = null;
  try {
    rendered = await block();
    return rendered;
  } catch (caught) {
    error = caught as Error;
    throw caught;
  } finally {
    // A request handed to Rails is audited by Rails.
    if (!(error instanceof NotPortedError || error instanceof HandBackToRails)) await writeAuditLog(admin, options, rendered, error);
  }
}

async function writeAuditLog(admin: AdminRequest, options: { action: string; target: AuditTarget | (() => AuditTarget); wrapper?: ParamsWrapper }, rendered: Rendered | null, error: Error | null): Promise<void> {
  const target = typeof options.target === "function" ? options.target() : options.target;
  await db.adminApiAuditLog.create({
    data: {
      actor_user_id: admin.admin.actor.id,
      admin_api_token_id: admin.admin.token.id,
      action: options.action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      target_external_id: target?.externalId ?? null,
      route: auditRoute(admin, options.action),
      http_method: admin.request.method,
      params_snapshot: redactedValue(wrappedParams(admin, options.wrapper), null, options.action) as Prisma.InputJsonValue,
      request_id: admin.request.headers.get("x-request-id") ?? randomUUID(),
      response_status: error !== null ? INTERNAL_SERVER_ERROR : (rendered?.status ?? null),
      error_class: error?.constructor.name ?? null,
      created_at: new Date(),
    },
  });
}

// The path carries the buyer's access token for the url redirect actions.
function auditRoute(admin: AdminRequest, action: string): string {
  if (!action.startsWith("url_redirects.")) return admin.request.path;
  return admin.request.path.replace(`/${admin.routeParams.id}/`, "/[REDACTED]/");
}
