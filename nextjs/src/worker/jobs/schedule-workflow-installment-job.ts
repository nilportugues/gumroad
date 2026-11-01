// Port of app/sidekiq/schedule_workflow_installment_job.rb: takes a scheduled intent (a workflow installment that was
// published or whose delay was edited) and asks the workflow to fan it out to its recipients.
// Golden: __fixtures__/schedule-workflow-installment.golden.json (scripts/golden/schedule-workflow-installment.rb).
//
// A delay edit also re-schedules the memberships that restarted since (`reschedule_pending_resubscribed_memberships`). A workflow
// that excludes buyers of other products, or whose filters Node does not read, goes back to Rails before the fanout is claimed.
import { Prisma, type Installment, type Workflow, type WorkflowInstallmentScheduleIntent } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { findById } from "../../server/models/row-reads.ts";
import { clearQueryCache, connectedTo } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { defaultSubscriptionDeps } from "../../server/models/subscription.ts";
import { assertMembershipsReschedulable, reschedulePendingResubscribedMemberships, reschedulesMemberships } from "../../server/models/workflow-resubscribed-memberships.ts";
import { WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS, WorkflowInstallmentScheduleIntents } from "../../server/models/workflow-installment-schedule-intent.ts";
import { claimFanoutBang, fanoutClaimable, markProcessedBang } from "../../server/models/workflow-installment-schedule-writes.ts";
import { scheduleInstallment } from "../../server/models/workflow-schedule-installment.ts";
import { WorkflowRecord } from "../../server/models/workflow.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";


export class IntentNotCommittedError extends Error {
  constructor() {
    super("ScheduleWorkflowInstallmentJob::IntentNotCommittedError");
    this.name = "ScheduleWorkflowInstallmentJob::IntentNotCommittedError";
  }
}

export class FanoutNotEnqueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleWorkflowInstallmentJob::FanoutNotEnqueuedError";
  }
}

const present = (value: unknown): boolean => value !== null && value !== undefined && !(typeof value === "string" && /^[\t\n\v\f\r ]*$/u.test(value));
const seconds = (time: Date | null) => (time === null ? null : Math.floor(time.getTime() / 1000));

type LogError = { logError: (message: string) => void };

export const scheduleWorkflowInstallmentJobWith = (overrides: Partial<JobDeps & LogError> = {}) =>
  modelJob({ min: 1, max: 2 }, async (args, deps) => {
    const [intentToken, dispatchToken = null] = args;
    const intentDeps = { ...deps, logError: overrides.logError ?? ((message: string) => console.error(message)) };

    await connectedTo("writing", () =>
      transaction(async () => {
        const [row] = await selectRows(
          Prisma.sql`SELECT ${Prisma.raw(`\`${WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS}\`.*`)} FROM ${table(WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS)} WHERE ${column(WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS, "token")} = ${intentToken as string} LIMIT 1 FOR UPDATE`,
        );
        if (row === undefined) return;
        const intent = WorkflowInstallmentScheduleIntents.load(castRow<WorkflowInstallmentScheduleIntent>("WorkflowInstallmentScheduleIntent", row));
        if (intent.get("processed_at") !== null) return;
        if (present(dispatchToken) && intent.get("dispatch_token") !== dispatchToken) {
          const now = deps.now();
          const active = (token: string | null, expires: Date | null) => present(token) && expires !== null && expires.getTime() > now.getTime();
          const anotherDispatchActive = active(intent.get("dispatch_token"), intent.get("dispatch_expires_at"));
          const fanoutActive = active(intent.get("fanout_token"), intent.get("fanout_expires_at"));
          if (!(anotherDispatchActive || fanoutActive)) throw new IntentNotCommittedError();
          return;
        }

        const installmentRow = await findById<Installment>("Installment", intent.get("installment_id"));
        const post = installmentRow === null ? null : new InstallmentPost(installmentRow);
        const rule = post === null ? null : await post.installmentRule();
        if (post === null || rule === null) {
          await markProcessedBang(intent, deps);
          return;
        }

        const currentVersion = rule.version;
        if (currentVersion < intent.get("rule_version")) throw new IntentNotCommittedError();

        let workflow = await post.workflow();
        if (workflow === null) {
          await markProcessedBang(intent, deps);
          return;
        }

        const expectedPublishedAt = intent.get("expected_published_at");
        if (expectedPublishedAt !== null) {
          // `workflow.with_lock { installment.reload; ... }`
          const matches = await transaction(async () => {
            const [locked] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`workflows`.*")} FROM ${table("workflows")} WHERE ${column("workflows", "id")} = ${workflow!.id} LIMIT 1 FOR UPDATE`);
            if (locked === undefined) throw new TypeError("Couldn't find Workflow");
            workflow = new WorkflowRecord(castRow<Workflow>("Workflow", locked));
            // Persistence#reload clears the query cache first.
            clearQueryCache();
            const [reloaded] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "id")} = ${installmentRow!.id} LIMIT 1`);
            if (reloaded === undefined) throw new TypeError("Couldn't find Installment");
            Object.assign(installmentRow!, castRow<Installment>("Installment", reloaded));
            const expected = seconds(expectedPublishedAt);
            return seconds(workflow.row.published_at) === expected && seconds(installmentRow!.published_at) === expected;
          });
          if (!matches) {
            await markProcessedBang(intent, deps);
            return;
          }
        }
        if (!(workflow.row.deleted_at === null && installmentRow!.deleted_at === null && installmentRow!.published_at !== null)) {
          await markProcessedBang(intent, deps);
          return;
        }

        const oldDelayedDeliveryTime = intent.get("old_delayed_delivery_time");
        // Memberships that restarted since a delay edit are rescheduled after the fanout is claimed; what Node cannot judge
        // there is decided first, while the intent can still go back to Rails untouched.
        if (oldDelayedDeliveryTime !== null && reschedulesMemberships(workflow) && fanoutClaimable(intent, deps.now())) {
          await beforeSideEffects(() => assertMembershipsReschedulable(workflow!));
        }
        const fanoutToken = await claimFanoutBang(intent, intentDeps);
        if (fanoutToken === null) return;
        if (oldDelayedDeliveryTime !== null) {
          await reschedulePendingResubscribedMemberships(post, workflow, rule, oldDelayedDeliveryTime, intent.get("cutoff_reference_time"), {
            subscriptionDeps: { now: deps.now, featureActive: defaultSubscriptionDeps.featureActive },
            notEnqueued: (message) => new FanoutNotEnqueuedError(message),
          });
        }

        const result = await scheduleInstallment(workflow, installmentRow!, {
          oldDelayedDeliveryTime,
          cutoffReferenceTime: intent.get("cutoff_reference_time"),
          rescheduleOnStale: oldDelayedDeliveryTime !== null,
          minimumRuleVersion: currentVersion,
          scheduleIntentToken: intent.get("token"),
          scheduleIntentFanoutToken: fanoutToken,
        });
        if (result === "enqueued") return;
        if (result === "not_applicable") {
          await markProcessedBang(intent, deps);
          return;
        }
        throw new FanoutNotEnqueuedError("Recipient fanout was not enqueued");
      }),
    );
  })(overrides);

export const scheduleWorkflowInstallmentJob = scheduleWorkflowInstallmentJobWith();
