// Api::V2::WorkflowsController, Api::V2::Workflows::EmailsController and Api::WorkflowPresenter.
import { Prisma, type Installment, type InstallmentRule, type User, type Workflow } from "@prisma/client";

import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { railsCache } from "../../cache/rails-cache.ts";
import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { summaries } from "../../models/email-engagement-store.ts";
import { InstallmentFlags } from "../../models/installment-post.ts";
import { displayableTimeDuration } from "../../models/installment-rule.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { WorkflowRecord } from "../../models/workflow.ts";
import { jsonFilters } from "../../page-props/audience/filters.ts";
import { RubyFloat } from "../../search/es-json.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";

import {
  authorize,
  error400,
  errorWithObject,
  halted,
  renderResponse,
  successWithObject,
  timeJson,
  type ApiCall,
} from "./ws17c-base.ts";

const API_CACHE_EXPIRATION_SECONDS = 5;
const API_CACHE_PREFIX = "api_workflow";
const PRODUCT_TYPE = "product";
const VARIANT_TYPE = "variant";
const ABANDONED_CART_TYPE = "abandoned_cart";
// InstallmentRule::HOUR..MONTH, and Duration's seconds (a month is a twelfth of 365.2425 days).
const DELAY_UNITS = ["hour", "day", "week", "month"] as const;
const SECONDS_PER_UNIT: Record<string, number> = { hour: 3600, day: 86_400, week: 604_800, month: 2_629_746 };
const MAX_DELAY_SECONDS = 2 ** 31 - 1;
const OVERFLOW_DELAY_MESSAGE = `Use a delay of ${Math.trunc(MAX_DELAY_SECONDS / (365 * 86_400))} years or less.`;
const WRITE_PARAMS = ["subject", "body", "delay_amount", "delay_unit"] as const;
const WORKFLOW_STATE_PARAMS = [
  "publish",
  "unpublish",
  "draft",
  "state",
  "published_at",
  "save_action_name",
  "send_to_past_customers",
] as const;

const externalId = (id: number | bigint) => encrypt(id);

type Linked = { id: number };
const find = async <T>(tableName: string, id: number | bigint | null): Promise<T | null> => {
  if (id === null) return null;
  const [row] = await selectRows<T>(
    Prisma.sql`SELECT * FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
};

// Installment#display_type
export function displayType(installment: Installment): "published" | "scheduled" | "draft" {
  if (installment.published_at !== null) return "published";
  return InstallmentFlags.isSet(installment.flags, "ready_to_publish") ? "scheduled" : "draft";
}

type EmailRow = { installment: Installment; rule: InstallmentRule };

async function emailsOf(workflow: Workflow): Promise<EmailRow[]> {
  const installments = await selectRows<Installment>(
    Prisma.sql`SELECT ${table("installments")}.* FROM ${table("installments")} INNER JOIN ${table("installment_rules")} ON ${column("installment_rules", "installment_id")} = ${column("installments", "id")} WHERE ${column("installments", "workflow_id")} = ${workflow.id} AND ${column("installments", "deleted_at")} IS NULL ORDER BY ${column("installment_rules", "delayed_delivery_time")} ASC, ${column("installments", "id")} ASC`,
  );
  const rules =
    installments.length === 0
      ? []
      : await selectRows<InstallmentRule>(
          Prisma.sql`SELECT * FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} IN (${Prisma.join(installments.map((installment) => installment.id))})`,
        );
  return installments.map((installment) => ({
    installment,
    rule: rules.find((rule) => rule.installment_id === installment.id)!,
  }));
}

// Post::Caching.cache_key_for(id, key)
const eventKey = (id: number, key: string) => `${key}_for_installment_${id}_ddb`;

// WorkflowPresenter#batched_counts: a count another request read in the last five seconds, else DynamoDB.
async function batchedCounts(
  emails: Installment[],
  key: "unique_open_count" | "unique_click_count",
  pick: "open_count" | "click_pair_count",
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const missing: number[] = [];
  for (const email of emails) {
    const cached = await railsCache().read(`${API_CACHE_PREFIX}_${eventKey(email.id, key)}`);
    if (cached === undefined) missing.push(email.id);
    else counts.set(email.id, Number(cached ?? 0));
  }
  if (missing.length === 0) return counts;
  const queried = await summaries(missing);
  for (const id of missing) {
    const count = queried.get(id)?.[pick] ?? 0;
    counts.set(id, count);
    await railsCache().write(`${API_CACHE_PREFIX}_${eventKey(id, key)}`, count, {
      expiresIn: API_CACHE_EXPIRATION_SECONDS,
    });
  }
  return counts;
}

// (count.fdiv(sent) * 100).round(1), nil for no sends
const rate = (count: number, sent: number) =>
  sent === 0 ? null : new RubyFloat(rubyFloatRoundDigits((count / sent) * 100, 1));

async function presentEmails(workflow: Workflow, rows: EmailRow[], includeAnalytics: boolean) {
  const link = await find<Linked>("links", workflow.link_id);
  const installments = rows.map((row) => row.installment);
  const opens = includeAnalytics
    ? await batchedCounts(installments, "unique_open_count", "open_count")
    : new Map<number, number>();
  const clicks = includeAnalytics
    ? await batchedCounts(installments, "unique_click_count", "click_pair_count")
    : new Map<number, number>();
  return rows.map(({ installment, rule }) => {
    const sent = installment.customer_count ?? 0;
    const open = opens.get(installment.id) ?? null;
    const click = clicks.get(installment.id) ?? null;
    const updated = [installment.updated_at, rule.updated_at].filter((time): time is Date => time !== null);
    return {
      id: externalId(installment.id),
      subject: installment.name,
      message: installment.message,
      audience_type: installment.installment_type,
      product_id: link ? externalId(link.id) : null,
      state: displayType(installment),
      published_at: timeJson(installment.published_at),
      send_emails: InstallmentFlags.isSet(installment.flags, "send_emails"),
      delay: { amount: displayableTimeDuration(rule), unit: rule.time_period },
      sent_count: sent,
      open_count: open,
      open_rate: open === null ? null : rate(open, sent),
      click_count: click,
      click_rate: click === null ? null : rate(click, sent),
      created_at: timeJson(installment.created_at),
      updated_at: timeJson(new Date(Math.max(...updated.map((time) => time.getTime())))),
    };
  });
}

async function workflowProps(
  seller: User,
  workflow: Workflow,
  options: { emailsCount?: number; includeEmails?: boolean },
) {
  const record = new WorkflowRecord(workflow);
  const link = await find<Linked>("links", workflow.link_id);
  const variant = await find<Linked>("base_variants", workflow.base_variant_id);
  const rows = options.emailsCount === undefined || options.includeEmails ? await emailsOf(workflow) : [];
  const { workflow_trigger: _trigger, ...filters } = jsonFilters(record, seller) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    id: externalId(workflow.id),
    name: workflow.name,
    audience_type: workflow.workflow_type,
    trigger: record.workflowTrigger,
    product_id: link ? externalId(link.id) : null,
    variant_id: variant ? externalId(variant.id) : null,
    state: workflow.published_at !== null ? "published" : "draft",
    published_at: timeJson(workflow.published_at),
    first_published_at: timeJson(workflow.first_published_at),
    send_to_past_customers: record.sendToPastCustomers,
    emails_count: options.emailsCount ?? rows.length,
    filters,
    created_at: timeJson(workflow.created_at),
    updated_at: timeJson(workflow.updated_at),
  };
  if (options.includeEmails) payload.emails = await presentEmails(workflow, rows, true);
  return payload;
}

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const workflows = await selectRows<Workflow>(
    Prisma.sql`SELECT * FROM ${table("workflows")} WHERE ${column("workflows", "seller_id")} = ${auth.owner.id} AND ${column("workflows", "deleted_at")} IS NULL ORDER BY ${column("workflows", "created_at")} DESC, ${column("workflows", "id")} DESC`,
  );
  const counts = new Map<number, number>();
  if (workflows.length > 0) {
    const grouped = await selectRows<{ workflow_id: number; count: bigint | number }>(
      Prisma.sql`SELECT ${column("installments", "workflow_id")}, COUNT(*) AS count FROM ${table("installments")} INNER JOIN ${table("installment_rules")} ON ${column("installment_rules", "installment_id")} = ${column("installments", "id")} WHERE ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "workflow_id")} IN (${Prisma.join(workflows.map((workflow) => workflow.id))}) GROUP BY ${column("installments", "workflow_id")}`,
    );
    for (const row of grouped) counts.set(Number(row.workflow_id), Number(row.count));
  }
  const props = [];
  for (const workflow of workflows)
    props.push(await workflowProps(auth.owner, workflow, { emailsCount: counts.get(workflow.id) ?? 0 }));
  return successWithObject("workflows", props);
}

// `current_seller.workflows.alive.find_by_external_id(id)`, nil when a product or variant workflow's product is not the seller's.
async function fetchWorkflow(owner: User, externalIdValue: string): Promise<Workflow | null> {
  const id = decrypt(externalIdValue);
  if (id === null) return null;
  const [workflow] = await selectRows<Workflow>(
    Prisma.sql`SELECT * FROM ${table("workflows")} WHERE ${column("workflows", "seller_id")} = ${owner.id} AND ${column("workflows", "deleted_at")} IS NULL AND ${column("workflows", "id")} = ${id} LIMIT 1`,
  );
  if (!workflow) return null;
  if (workflow.workflow_type === PRODUCT_TYPE || workflow.workflow_type === VARIANT_TYPE) {
    const link = await find<{ id: number; user_id: number }>("links", workflow.link_id);
    if (!link || BigInt(link.user_id) !== BigInt(owner.id)) return null;
  }
  return workflow;
}

const workflowNotFound = (): ActionResult => ({ ...errorWithObject("workflow", null, false), rescued: true });

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const workflow = await fetchWorkflow(auth.owner, call.routeParams.id!);
  if (workflow === null) return workflowNotFound();
  return successWithObject("workflow", await workflowProps(auth.owner, workflow, { includeEmails: true }));
}

// Api::V2::Workflows::EmailsController#parsed_delay_amount
function parsedDelayAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  return null;
}

const present = (call: ApiCall, key: string) => key in call.params;
const bad = (message: string): ActionResult => error400(message);

// #valid_write_params?: a message to refuse with, or null.
function writeParamsError(call: ApiCall, workflow: Workflow, requireAll: boolean): string | null {
  const stateParam = WORKFLOW_STATE_PARAMS.find((key) => present(call, key));
  if (stateParam) return `${stateParam} cannot be changed through this endpoint.`;
  const supplied = WRITE_PARAMS.filter((key) => present(call, key));
  if (requireAll) {
    const missing = WRITE_PARAMS.find((key) => !supplied.includes(key));
    if (missing) return `${missing} is required.`;
  } else if (supplied.length === 0) return "Provide at least one of: subject, body, delay_amount, or delay_unit.";
  const { subject, body } = call.params;
  if (present(call, "subject") && (typeof subject !== "string" || subject.trim() === ""))
    return "subject must be a non-empty string.";
  if (present(call, "body") && typeof body !== "string") return "body must be a string.";
  const delayParams = (["delay_amount", "delay_unit"] as const).filter((key) => present(call, key));
  if (delayParams.length === 0) return null;
  if (workflow.workflow_type === ABANDONED_CART_TYPE) return "delay cannot be changed for abandoned cart workflows.";
  if (delayParams.length !== 2) return "delay_amount and delay_unit must be provided together.";
  const amount = parsedDelayAmount(call.params.delay_amount);
  if (amount === null || amount < 0) return "delay_amount must be a non-negative integer.";
  const unit = call.params.delay_unit;
  if (typeof unit !== "string" || !(DELAY_UNITS as readonly string[]).includes(unit))
    return `delay_unit must be one of: ${DELAY_UNITS.join(", ")}.`;
  if (amount * SECONDS_PER_UNIT[unit]! > MAX_DELAY_SECONDS) return OVERFLOW_DELAY_MESSAGE;
  return null;
}

export async function createEmail(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const workflow = await fetchWorkflow(auth.owner, call.routeParams.workflow_id!);
  if (workflow === null) return workflowNotFound();
  if (workflow.workflow_type === ABANDONED_CART_TYPE) return bad("Emails cannot be added to abandoned cart workflows.");
  const message = writeParamsError(call, workflow, true);
  if (message) return bad(message);
  // Workflow::SaveInstallmentsService (rules, schedule intents, sanitizing, moderation) is not ported.
  throw new HandBackToRails("a workflow email write");
}

export async function updateEmail(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_emails"]);
  if (halted(auth)) return auth.halt;
  const workflow = await fetchWorkflow(auth.owner, call.routeParams.workflow_id!);
  if (workflow === null) return workflowNotFound();
  const emailId = decrypt(call.routeParams.email_id!);
  const [email] =
    emailId === null
      ? []
      : await selectRows<Installment>(
          Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "workflow_id")} = ${workflow.id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "id")} = ${emailId} LIMIT 1`,
        );
  if (!email) return { ...errorWithObject("email", null, false), rescued: true };
  const message = writeParamsError(call, workflow, false);
  if (message) return bad(message);
  throw new HandBackToRails("a workflow email write");
}
