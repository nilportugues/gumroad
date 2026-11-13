// Workflow::SaveInstallmentsService (app/services/workflow/save_installments_service.rb) for the save of the emails page
// (`replace_all: true`). Recorded by spec/requests/workflows_emails_update_spec.rb.
//
// What Node cannot prove throws NotPortedError before the first write of the transaction, and the controller hands the request
// to Rails: an email with files, a preview of an email with files, a message holding an upsell card, a delay that is not
// a whole number of a known unit, and the seller or file checks the Installment and Workflow writes refuse (installment-writes.ts).
import { randomUUID } from "node:crypto";

import { Prisma, type Installment, type InstallmentRule, type User, type Workflow } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { PostEmailNotPortedError } from "../mail/post-email-template.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { jsonData } from "./concerns/json-data.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
import { nokogiriRoundtrip } from "./html-fragment.ts";
import { InstallmentFlags } from "./installment-post.ts";
import {
  advanceVersionBang,
  InstallmentRules,
  markDeletedBang as markRuleDeletedBang,
} from "./installment-rule-writes.ts";
import { sendPostPreview } from "./installment-send.ts";
import {
  InstallmentInvalid,
  Installments,
  markDeletedBang as markInstallmentDeletedBang,
  post,
} from "./installment-writes.ts";
import { defaultPostEmailDeps, ResendApiResponseError, SendGridApiResponseError } from "./post-email-api.ts";
import { type Errors, RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { PreviewEmailError, saveInstallmentFiles } from "./save-installment.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";
import { enqueueBang } from "./workflow-installment-schedule-writes.ts";
import { SAVE_AND_PUBLISH_ACTION, SAVE_AND_UNPUBLISH_ACTION } from "./workflow-manage.ts";
import { installmentOf, publishBang, unpublishBang, Workflows } from "./workflow-writes.ts";
import { WorkflowFlags } from "./workflow.ts";

type WorkflowModel = ModelRecord<Workflow>;
type InstallmentModel = ModelRecord<Installment>;

export const SAVE_ACTION = "save";
const ABANDONED_CART_TYPE = "abandoned_cart";
const ABANDONED_CART_EMAIL_COUNT_MESSAGE = "An abandoned cart workflow can only have one email.";
const PRODUCT_LIST_PLACEHOLDER = "<product-list-placeholder />";
const PREVIEW_UNCONFIRMED_MESSAGE = "You have to confirm your email address before you can do that.";
const INSTALLMENT_REQUIRED_MESSAGE = "Installments data is required";
const WORKFLOW_NOT_FOUND_MESSAGE = "The workflow was not found.";
// ActiveSupport: 1.hour, 1.day, 1.week and 1.month (a twelfth of 365.2425 days)
const SECONDS_PER_UNIT: Record<string, number> = { hour: 3600, day: 86_400, week: 604_800, month: 2_629_746 };
// FlagShihTzu::TRUE_VALUES
const TRUE_VALUES = [true, 1, "1", "t", "T", "true", "TRUE"];
const SCALAR_KEYS = ["id", "name", "message", "time_period", "time_duration", "send_preview_email"] as const;

const refuse = (what: string): never => {
  throw new NotPortedError(what, "workflow/save_installments_service.rb");
};

type Scalar = string | number | boolean | null;
export type EmailParams = Partial<Record<(typeof SCALAR_KEYS)[number], Scalar>> & { files?: [] };
export type SaveInstallmentsParams = {
  send_to_past_customers?: Scalar;
  save_action_name?: Scalar;
  installments?: EmailParams[];
};

const isScalar = (value: unknown): value is Scalar =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `params.require(:workflow).permit(...)`: only what Node can read the way Rails would; the rest goes back whole.
export function permitInstallments(raw: unknown): SaveInstallmentsParams {
  if (!isHash(raw) || Object.keys(raw).length === 0) return refuse("a workflow parameter that is not a populated hash");
  const out: SaveInstallmentsParams = {};
  for (const key of ["send_to_past_customers", "save_action_name"] as const) {
    if (!(key in raw)) continue;
    if (!isScalar(raw[key])) return refuse(`a ${key} that is not a scalar`);
    out[key] = raw[key];
  }
  if (!("installments" in raw)) return out;
  if (!Array.isArray(raw.installments)) return refuse("installments that are not a list");
  out.installments = raw.installments.map((entry): EmailParams => {
    if (!isHash(entry)) return refuse("an installment that is not a hash");
    const email: EmailParams = {};
    for (const key of SCALAR_KEYS) {
      if (!(key in entry)) continue;
      if (!isScalar(entry[key])) return refuse(`an installment ${key} that is not a scalar`);
      email[key] = entry[key];
    }
    if ("files" in entry) {
      if (!Array.isArray(entry.files) || entry.files.length > 0)
        return refuse("an email with files (SaveFilesService)");
      email.files = [];
    }
    return email;
  });
  return out;
}

// InstallmentRuleHelper#convert_to_seconds
function convertToSeconds(duration: Scalar | undefined, period: Scalar | undefined): number {
  const unit = typeof period === "string" ? SECONDS_PER_UNIT[period] : undefined;
  if (unit === undefined) return refuse("a delay unit that is not hour, day, week or month");
  if (typeof duration === "boolean") return refuse("a delay that is a boolean");
  // `nil.to_i`, `Integer#to_i`, `Float#to_i` and `String#to_i`
  const whole =
    duration === null || duration === undefined
      ? 0
      : typeof duration === "number"
        ? Math.trunc(duration)
        : rubyToI(duration);
  return whole * unit;
}

// `workflow.installments.alive`
async function aliveInstallments(workflow: WorkflowModel): Promise<Installment[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "workflow_id")} = ${workflow.get("id")} AND ${column("installments", "deleted_at")} IS NULL ORDER BY ${column("installments", "id")}`,
  );
  return rows.map((row) => castRow<Installment>("Installment", row));
}

// `installment.installment_rule` (has_one, with the inverse `installment` set), or `build_installment_rule`.
async function ruleOf(record: InstallmentModel): Promise<ModelRecord<InstallmentRule>> {
  const row = await post(record).installmentRule();
  const rule = row === null ? InstallmentRules.build({ installment_id: record.get("id") }) : InstallmentRules.load(row);
  if (row !== null) rule.touch("installment_id");
  setAssociation(rule, "installment", record.get("id"), record.attributes as Installment);
  return rule;
}

// delete_removed_installments
async function deleteRemovedInstallments(workflow: WorkflowModel, emails: EmailParams[], now: () => Date) {
  const kept = new Set(emails.map((email) => email.id));
  for (const row of await aliveInstallments(workflow)) {
    if (kept.has(encrypt(row.id))) continue;
    const installment = installmentOf(row);
    const ruleRow = await post(installment).installmentRule();
    const rule = ruleRow === null ? null : InstallmentRules.load(ruleRow);
    if (rule !== null) await advanceVersionBang(rule, { now });
    await markInstallmentDeletedBang(installment, { now });
    if (rule !== null) await markRuleDeletedBang(rule, { now });
  }
}

// `workflow.installments.alive.find_by_external_id(id)`
async function findAlive(workflow: WorkflowModel, externalId: Scalar | undefined): Promise<InstallmentModel | null> {
  if (typeof externalId !== "string") return null;
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "workflow_id")} = ${workflow.get("id")} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  if (!row) return null;
  const installment = Installments.load(castRow<Installment>("Installment", row));
  installment.touch("workflow_id");
  return installment;
}

// inherit_workflow_info
function inheritWorkflowInfo(installment: InstallmentModel, workflow: WorkflowModel): void {
  const neverPublished = workflow.get("first_published_at") === null;
  let flags = installment.get("flags");
  if (installment.newRecord || neverPublished) {
    const sendToPast = WorkflowFlags.isSet(workflow.get("flags"), "send_to_past_customers");
    installment.set("installment_type", workflow.get("workflow_type"));
    installment.set("json_data", workflow.get("json_data") ?? JSON.stringify(jsonData(workflow)));
    installment.set("seller_id", workflow.get("seller_id"));
    installment.set("link_id", workflow.get("link_id"));
    installment.set("base_variant_id", workflow.get("base_variant_id"));
    flags = Number(InstallmentFlags.set(flags, "is_for_new_customers_of_workflow", !sendToPast));
  }
  installment.set("published_at", workflow.get("published_at"));
  flags = Number(
    InstallmentFlags.set(
      flags,
      "workflow_installment_published_once_already",
      workflow.get("first_published_at") !== null,
    ),
  );
  installment.set("flags", flags);
}

// save_installment_rule_and_reschedule_installment
async function saveRule(
  installment: InstallmentModel,
  email: EmailParams,
  saveActionName: Scalar | undefined,
  now: () => Date,
): Promise<void> {
  const rule = await ruleOf(installment);
  if (rule.persisted) await InstallmentRules.lockBang(rule);
  const newDelay = convertToSeconds(email.time_duration, email.time_period);
  const oldDelay = rule.get("delayed_delivery_time");
  rule.set("time_period", email.time_period as string);
  if (oldDelay === newDelay) {
    await InstallmentRules.saveBang(rule, { now });
    return;
  }
  rule.set("delayed_delivery_time", newDelay);
  await InstallmentRules.saveBang(rule, { now });
  if (installment.get("published_at") !== null && saveActionName === SAVE_ACTION) {
    await enqueueBang(
      {
        installmentId: Number(installment.get("id")),
        ruleVersion: rule.get("version"),
        oldDelayedDeliveryTime: oldDelay,
        cutoffReferenceTime: now(),
      },
      { now, uuid: () => randomUUID(), logError: (message) => console.error(message) },
    );
  }
}

// ActiveModel::Errors#to_hash, the messages Inertia keeps in the session
function groupedMessages(errors: Errors): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const { attribute, message } of errors.details) (grouped[attribute] ??= []).push(message);
  return grouped;
}

// `installment_params[:send_preview_email]` in the service: anything but nil and false.
const previewRequested = (email: EmailParams) =>
  email.send_preview_email !== undefined && email.send_preview_email !== null && email.send_preview_email !== false;

// ActiveModel::Type::Boolean#cast, which the controller uses to pick its notice: "" and nil are nil, these are false.
const FALSE_VALUES = [false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"];
export const previewNoticeRequested = (params: SaveInstallmentsParams) =>
  (params.installments ?? []).some((email) => {
    const flag = email.send_preview_email;
    return flag !== undefined && flag !== null && flag !== "" && !FALSE_VALUES.includes(flag);
  });

export type PreviewRecipient = {
  id: number | bigint;
  email: string;
  unconfirmed_email: string | null;
  confirmed_at: Date | null;
};

// Installment#send_preview_email: the provider failing is the seller's error, not a 500. Sent inside the transaction, as
// Ruby does, so a later failure rolls the save back after the mail has gone.
export async function previewThroughPostEmailApi(preview: ReturnType<typeof post>, email: string): Promise<void> {
  try {
    await sendPostPreview(preview, email, defaultPostEmailDeps());
  } catch (caught) {
    if (caught instanceof PostEmailNotPortedError) refuse(caught.message);
    if (caught instanceof ResendApiResponseError || caught instanceof SendGridApiResponseError)
      throw new PreviewEmailError("Failed to send preview email. Please try again later.");
    throw caught;
  }
}

export type SaveInstallmentsResult = { ok: true } | { ok: false; error: string; errors: Record<string, string[]> };

// Workflow::SaveInstallmentsService#process
export async function saveInstallments(
  input: {
    seller: User;
    params: SaveInstallmentsParams;
    workflow: WorkflowModel;
    previewRecipient: PreviewRecipient | null;
  },
  options: { now?: () => Date } = {},
): Promise<SaveInstallmentsResult> {
  const { seller, params, workflow } = input;
  const now = options.now ?? (() => new Date());
  const emails = params.installments;
  if (emails === undefined) {
    const error = INSTALLMENT_REQUIRED_MESSAGE;
    return { ok: false, error, errors: { base: [error] } };
  }

  const abandoned = workflow.get("workflow_type") === ABANDONED_CART_TYPE;
  const recipient = input.previewRecipient;
  // `has_unconfirmed_email?`
  const recipientUnconfirmed = recipient !== null && (!!recipient.unconfirmed_email || recipient.confirmed_at === null);
  if (emails.some(previewRequested)) {
    if (recipient === null) refuse("a preview email with no recipient");
  }

  const previews: { recipientId: number; installmentId: number }[] = [];
  const failure: { value: SaveInstallmentsResult | null } = { value: null };
  try {
    await transaction(
      async () => {
        await Workflows.lockBang(workflow);
        if (workflow.get("deleted_at") !== null) {
          failure.value = {
            ok: false,
            error: WORKFLOW_NOT_FOUND_MESSAGE,
            errors: { base: [WORKFLOW_NOT_FOUND_MESSAGE] },
          };
          return false;
        }
        if (abandoned && emails.length !== 1) {
          failure.value = {
            ok: false,
            error: ABANDONED_CART_EMAIL_COUNT_MESSAGE,
            errors: { base: [ABANDONED_CART_EMAIL_COUNT_MESSAGE] },
          };
          return false;
        }

        if (workflow.get("first_published_at") === null) {
          const value = params.send_to_past_customers;
          workflow.set(
            "flags",
            WorkflowFlags.set(workflow.get("flags"), "send_to_past_customers", TRUE_VALUES.includes(value as never)),
          );
          await Workflows.saveBang(workflow, { now });
        }

        await deleteRemovedInstallments(workflow, emails, now);

        for (const email of emails) {
          let installment = await findAlive(workflow, email.id);
          installment ??= Installments.build({ workflow_id: Number(workflow.get("id")) } as Partial<Installment>);
          installment.set("name", (email.name ?? null) as string);
          if (typeof email.message !== "string") refuse("an email whose message is not text");
          let message = email.message as string;
          if (abandoned && !message.includes("product-list-placeholder")) message += PRODUCT_LIST_PLACEHOLDER;
          // SaveContentUpsellsService#from_html
          for (const html of [installment.attributeWas("message"), message])
            if (html !== null && /upsell-card/iu.test(html))
              refuse("a message with an upsell card (SaveContentUpsellsService)");
          installment.set("message", nokogiriRoundtrip(message));
          installment.set("flags", Number(InstallmentFlags.set(installment.get("flags"), "send_emails", true)));
          inheritWorkflowInfo(installment, workflow);
          setAssociation(installment, "seller", workflow.get("seller_id"), seller);
          post(installment).preload("seller", seller);
          await Installments.saveBang(installment, { now });
          await saveInstallmentFiles(installment, { installment: { files: [] } });
          await saveRule(installment, email, params.save_action_name, now);

          if (previewRequested(email)) {
            if (recipientUnconfirmed) throw new PreviewEmailError(PREVIEW_UNCONFIRMED_MESSAGE);
            if (abandoned)
              previews.push({ recipientId: Number(recipient!.id), installmentId: Number(installment.get("id")) });
            else await previewThroughPostEmailApi(post(installment), recipient!.email);
          }
        }

        if (params.save_action_name === SAVE_AND_PUBLISH_ACTION) await publishBang(workflow, { now });
        if (params.save_action_name === SAVE_AND_UNPUBLISH_ACTION) await unpublishBang(workflow, { now });
        return true;
      },
      { returningStatus: true },
    );
  } catch (caught) {
    if (caught instanceof RecordInvalid) {
      return {
        ok: false,
        error: caught.errors.fullMessages()[0] ?? caught.message,
        errors: groupedMessages(caught.errors),
      };
    }
    if (caught instanceof InstallmentInvalid || caught instanceof PreviewEmailError)
      return { ok: false, error: caught.message, errors: { base: [caught.message] } };
    throw caught;
  }
  if (failure.value) return failure.value;
  // `deliver_later` inside the transaction; a later failure cannot follow it, since only an abandoned cart gets here and it saves one email.
  for (const { recipientId, installmentId } of previews)
    await deliverLater(
      currentJobsRuntime(),
      {
        mailer: "CustomerMailer",
        method: "abandoned_cart_preview",
        args: [recipientId, installmentId],
      },
      mailRoute("CustomerMailer", "abandoned_cart_preview"),
    );
  return { ok: true };
}
