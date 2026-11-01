// Port of Workflow#schedule_installment (app/models/workflow.rb): which job fans a published workflow installment out
// to its recipients, and with which arguments. It only enqueues; the jobs it names stay in Ruby.
// Golden: worker/jobs/__fixtures__/schedule-workflow-installment.golden.json.
import type { Installment } from "@prisma/client";

import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { InstallmentFlags } from "./installment-post.ts";
import type { WorkflowRecord } from "./workflow.ts";

export type ScheduleResult = "enqueued" | "not_enqueued" | "not_applicable";

export type ScheduleOptions = {
  oldDelayedDeliveryTime?: number | null;
  cutoffReferenceTime: Date;
  rescheduleOnStale?: boolean;
  minimumRuleVersion?: number | null;
  scheduleIntentToken?: string | null;
  scheduleIntentFanoutToken?: string | null;
};

const present = (value: string | number | null | undefined) => value !== null && value !== undefined && !(typeof value === "string" && /^[\t\n\v\f\r ]*$/u.test(value));

// Time#iso8601 of a UTC time: whole seconds.
const iso8601 = (time: Date) => `${new Date(Math.floor(time.getTime() / 1000) * 1000).toISOString().slice(0, 19)}Z`;

export async function scheduleInstallment(workflow: WorkflowRecord, installment: Installment, options: ScheduleOptions): Promise<ScheduleResult> {
  const { cutoffReferenceTime } = options;
  const old = options.oldDelayedDeliveryTime ?? null;
  const minimumRuleVersion = options.minimumRuleVersion ?? null;
  const token = options.scheduleIntentToken ?? null;
  const fanoutToken = options.scheduleIntentFanoutToken ?? null;
  const published = (installment.published_at ?? null) !== null;

  if (installment.installment_type === "abandoned_cart") return "not_applicable";
  if (workflow.row.deleted_at !== null) return "not_applicable";
  if (!published) return "not_applicable";

  const delayEditRecovery = options.rescheduleOnStale === true && present(old);
  const withIntent = present(token) || present(fanoutToken);
  const enqueued = async (jobClass: string, args: JsonValue[]): Promise<ScheduleResult> => ((await performAsync(jobClass, args)) ? "enqueued" : "not_enqueued");

  if (workflow.memberCancellationTrigger) {
    if (delayEditRecovery) {
      const args: JsonValue[] = [installment.id, old, iso8601(cutoffReferenceTime)];
      const intentGiven = present(minimumRuleVersion) || withIntent;
      if (intentGiven) args.push(minimumRuleVersion);
      if (withIntent) args.push(token);
      if (present(fanoutToken)) args.push(fanoutToken);
      return enqueued("SendWorkflowEmailsToPastCanceledMembersJob", args);
    }
    if (workflow.sendToPastCustomers) {
      const args: JsonValue[] = [installment.id];
      if (present(minimumRuleVersion) || withIntent) args.push(null, null, minimumRuleVersion);
      if (withIntent) args.push(token, fanoutToken);
      return enqueued("SendWorkflowEmailsToPastCanceledMembersJob", args);
    }
    return "not_applicable";
  }

  if (!workflow.newCustomerTrigger) return "not_applicable";
  const newCustomersOnly = InstallmentFlags.isSet(installment.flags, "is_for_new_customers_of_workflow");
  // Not scheduled before (no old delay) and only for new customers: nothing is due to anybody yet.
  if (old === null && newCustomersOnly) return "not_applicable";

  // The purchases and followers after this time have not been sent the post and need it (re-)scheduled.
  let earliestValidTime: Date | null;
  if (old === null) earliestValidTime = null;
  else if (newCustomersOnly && installment.published_at!.getTime() >= cutoffReferenceTime.getTime() - old * 1000) earliestValidTime = installment.published_at!;
  else earliestValidTime = new Date(cutoffReferenceTime.getTime() - old * 1000);

  const args: JsonValue[] = [installment.id, earliestValidTime === null ? null : iso8601(earliestValidTime)];
  if (delayEditRecovery || present(minimumRuleVersion) || withIntent) args.push(delayEditRecovery);
  if (present(minimumRuleVersion) || withIntent) args.push(minimumRuleVersion);
  if (withIntent) args.push(token, fanoutToken);
  return enqueued("SendWorkflowPostEmailsJob", args);
}
