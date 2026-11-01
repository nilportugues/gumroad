// InstallmentPresenter#props: one email (a post or a workflow email) as the workflow and email pages list it.
//
// Not ported, each refused with NotPortedError: a post with attached files (ProductFile#as_json signs
// download URLs and reads thumbnails), a post without a name (the name is read off the stripped
// message), and a post that was ever sent as a blast (its delivery state is read from Redis counters).
import { Prisma, type Installment, type InstallmentRule, type User } from "@prisma/client";

import { displayableTimeDuration } from "../../models/installment-rule.ts";
import { summaries, summary, type EngagementSummary } from "../../models/email-engagement-store.ts";
import { MEMBER_CANCELLATION_WORKFLOW_TRIGGER } from "../../models/workflow.ts";
import { filterValue, parseJsonData, castBoolean } from "../../models/with-filtering.ts";
import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { externalId, present } from "./support.ts";
import { jsonFilters } from "./filters.ts";

export const INSTALLMENTS = "installments";
// Installment flags (flag_shih_tzu: flag n is bit n - 1).
const FLAG = {
  isForNewCustomersOfWorkflow: 2 ** 5,
  workflowInstallmentPublishedOnceAlready: 2 ** 6,
  shownOnProfile: 2 ** 7,
  sendEmails: 2 ** 8,
  readyToPublish: 2 ** 9,
  allowComments: 2 ** 10,
} as const;

export const flagSet = (flags: number, flag: number) => (flags & flag) > 0;

// What the presenter reads next to the row: the rule, the engagement counters and the link/variant of a
// product or variant email.
export type InstallmentContext = {
  rule: InstallmentRule | null;
  engagement: EngagementSummary;
  permalink: string | null;
  variantExternalId: string | null;
};

const percent = (count: number, delivered: number | null): number | null => {
  if (delivered === null) return null;
  if (delivered === 0) return 100;
  return rubyFloatRoundDigits((count / delivered) * 100, 1);
};

// Installment#displayed_name: the name, or the message cut to 48 characters.
function displayedName(installment: Installment): string {
  if (present(installment.name)) return installment.name;
  throw new NotPortedError("Installment#displayed_name for an email without a name (truncate(strip_tags(message)))");
}

export async function aliveProductFileCount(installmentId: number): Promise<number> {
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("product_files")} WHERE ${column("product_files", "installment_id")} = ${installmentId} AND ${column("product_files", "deleted_at")} IS NULL`,
  );
  return Number(row?.count ?? 0);
}

// Installment#member_cancellation_trigger?
export function memberCancellationTrigger(installment: Installment, workflowTrigger: string | null): boolean {
  const own = filterValue({ jsonData: () => parseJsonData(installment.json_data) }, "workflow_trigger");
  return own === MEMBER_CANCELLATION_WORKFLOW_TRIGGER || workflowTrigger === MEMBER_CANCELLATION_WORKFLOW_TRIGGER;
}

// The installments' engagement counters, read in one batch (Installment.preload_engagement_summaries!).
export const preloadEngagement = (installments: Installment[]) => summaries(installments.map((installment) => installment.id));
export { summary as engagementOf };

export type PropsOptions = {
  seller: User;
  installment: Installment;
  context: InstallmentContext;
  // The workflow's own trigger, for the workflow's emails.
  workflowTrigger: string | null;
};

// The attributes InstallmentPresenter#props starts from, up to the product permalink: the same for a
// post and for a workflow email.
export async function installmentBaseProps({ seller, installment, context }: Omit<PropsOptions, "workflowTrigger">): Promise<Record<string, unknown>> {
  if ((await aliveProductFileCount(installment.id)) > 0) throw new NotPortedError("InstallmentPresenter#props for an email with files (ProductFile#as_json)");
  const flags = installment.flags;
  const published = installment.published_at !== null;
  const json = parseJsonData(installment.json_data);

  const props: Record<string, unknown> = {
    name: displayedName(installment),
    message: installment.message,
    files: [],
    published_at: installment.published_at ? installment.published_at.toISOString() : null,
    updated_at: installment.updated_at.toISOString(),
    external_id: externalId(installment.id),
    stream_only: false,
    call_to_action_text: installment.call_to_action_text,
    call_to_action_url: installment.call_to_action_url,
    streamable: false,
    sent_count: installment.customer_count,
    click_count: context.engagement.click_pair_count,
    open_count: context.engagement.open_count,
    click_rate: percent(context.engagement.click_pair_count, installment.customer_count),
    open_rate: percent(context.engagement.open_count, installment.customer_count),
    send_emails: flagSet(flags, FLAG.sendEmails),
    shown_on_profile: flagSet(flags, FLAG.shownOnProfile),
    installment_type: installment.installment_type,
    paid_more_than_cents: filterValue({ jsonData: () => json }, "paid_more_than_cents"),
    paid_less_than_cents: filterValue({ jsonData: () => json }, "paid_less_than_cents"),
    allow_comments: flagSet(flags, FLAG.allowComments),
    display_type: published ? "published" : flagSet(flags, FLAG.readyToPublish) ? "scheduled" : "draft",
  };
  // `attrs.merge!(installment.json_filters)`, then (at the end) `except(:paid_more_than, :paid_less_than)`
  Object.assign(props, jsonFilters({ jsonData: () => json }, seller));
  if (installment.installment_type === "product" || installment.installment_type === "variant") {
    props.unique_permalink = context.permalink;
    if (installment.installment_type === "variant") props.variant_external_id = context.variantExternalId;
  }
  return props;
}

// InstallmentPresenter#props, for an email that belongs to a workflow.
export async function workflowInstallmentProps({ seller, installment, context, workflowTrigger }: PropsOptions): Promise<Record<string, unknown>> {
  const flags = installment.flags;
  const published = installment.published_at !== null;
  const rule = context.rule;
  if (rule === null) throw new NotPortedError("InstallmentPresenter#props for a workflow email without an installment rule");
  const props = await installmentBaseProps({ seller, installment, context });
  const duration = displayableTimeDuration(rule);
  const period = rule.time_period ?? "";
  const humanized = period === "" ? "" : period.charAt(0).toUpperCase() + period.slice(1);

  Object.assign(props, {
    published_once_already: flagSet(flags, FLAG.workflowInstallmentPublishedOnceAlready) || published,
    member_cancellation: memberCancellationTrigger(installment, workflowTrigger),
    new_customers_only: flagSet(flags, FLAG.isForNewCustomersOfWorkflow),
    delayed_delivery_time_duration: duration,
    delayed_delivery_time_period: rule.time_period,
    displayed_delayed_delivery_time_period: duration === 1 ? humanized : `${humanized}s`,
  });
  const { paid_more_than: _more, paid_less_than: _less, ...rest } = props;
  return rest;
}

export { castBoolean };
