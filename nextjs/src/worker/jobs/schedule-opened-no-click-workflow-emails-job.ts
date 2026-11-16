// Port of app/sidekiq/schedule_opened_no_click_workflow_emails_job.rb: every alive, published email of an alive workflow whose trigger
// is opened_no_click queues SendWorkflowEmailsToOpenedNonClickersJob, read in batches of 200 and pushed batch by batch like Rails.
// Golden: __fixtures__/schedule-opened-no-click-workflow-emails-job.golden.json
// (scripts/golden/schedule-opened-no-click-workflow-emails-job.rb).
import { Prisma, type Installment } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { column, findInBatches, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const INSTALLMENTS = "installments";
const WORKFLOWS = "workflows";
const OPENED_NO_CLICK_WORKFLOW_TRIGGER = "opened_no_click";
const SCAN_BATCH_SIZE = 200;
const SEND_JOB = "SendWorkflowEmailsToOpenedNonClickersJob";

export const scheduleOpenedNoClickWorkflowEmailsJobWith = modelJob({ min: 0, max: 0 }, async () => {
  const where = Prisma.sql`${column(INSTALLMENTS, "deleted_at")} IS NULL AND ${column(INSTALLMENTS, "published_at")} IS NOT NULL AND ${column(WORKFLOWS, "deleted_at")} IS NULL AND (workflows.json_data->>'$.workflow_trigger' = ${OPENED_NO_CLICK_WORKFLOW_TRIGGER})`;
  const joins = Prisma.sql`INNER JOIN ${table(WORKFLOWS)} ON ${column(WORKFLOWS, "id")} = ${column(INSTALLMENTS, "workflow_id")}`;
  await findInBatches<Installment>(
    INSTALLMENTS,
    where,
    SCAN_BATCH_SIZE,
    async (installments) => {
      for (const installment of installments) await performAsync(SEND_JOB, [installment.id]);
    },
    null,
    joins,
  );
});

export const scheduleOpenedNoClickWorkflowEmailsJob = scheduleOpenedNoClickWorkflowEmailsJobWith();
