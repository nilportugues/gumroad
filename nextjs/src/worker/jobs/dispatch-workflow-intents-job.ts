// Port of app/sidekiq/dispatch_pending_workflow_installment_schedule_intents_job.rb.
import type { WorkflowInstallmentScheduleIntent } from "@prisma/client";

import { findInBatches } from "../../server/models/sql.ts";
import { dispatchableScope, enqueueIntent, WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS } from "../../server/models/workflow-installment-schedule-intent.ts";
import { modelJob, type JobDeps } from "./support/job-deps.ts";

type LogError = { logError: (message: string) => void };

export const dispatchPendingWorkflowInstallmentScheduleIntentsJobWith = (overrides: Partial<JobDeps & LogError> = {}) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    // Rails.logger.error
    const logError = overrides.logError ?? ((message: string) => console.error(message));
    // `dispatchable` takes Time.current once; every batch reuses it.
    const at = deps.now();
    await findInBatches<WorkflowInstallmentScheduleIntent>(WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS, dispatchableScope(at), 1_000, async (rows) => {
      for (const intent of rows) await enqueueIntent(intent.token, { ...deps, logError });
    });
  })(overrides);

export const dispatchPendingWorkflowInstallmentScheduleIntentsJob = dispatchPendingWorkflowInstallmentScheduleIntentsJobWith();
