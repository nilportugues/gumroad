// The installments of a workflow that its schedulers (`Purchase#schedule_workflows`,
// `Subscription#schedule_member_cancellation_workflow_jobs`) push a SendWorkflowInstallmentWorker for.
import type { Installment, InstallmentRule } from "@prisma/client";

import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { aliveInstallments, installmentRuleOf, type WorkflowRecord } from "./workflow.ts";

export const SEND_WORKFLOW_INSTALLMENT_WORKER = "SendWorkflowInstallmentWorker";

// `SendWorkflowInstallmentWorker.perform_at(at, *args)`
export type WorkflowPush = { at: Date; args: JsonValue[] };

// `workflow.installments.alive[.published]` with each `installment.installment_rule`, skipping the
// installments without one (`next if installment_rule.nil?`).
export async function schedulableInstallments(workflow: WorkflowRecord, { published }: { published: boolean }): Promise<{ installment: Installment; rule: InstallmentRule }[]> {
  const out: { installment: Installment; rule: InstallmentRule }[] = [];
  for (const installment of await aliveInstallments(workflow.id, { published })) {
    const rule = await installmentRuleOf(installment.id);
    if (rule !== null) out.push({ installment, rule });
  }
  return out;
}
