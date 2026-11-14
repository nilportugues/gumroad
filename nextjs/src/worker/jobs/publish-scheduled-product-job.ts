// Port of app/sidekiq/publish_scheduled_product_job.rb up to `ProductPublishSchedule.find_by(id:)`. A schedule that does not exist
// finishes in Node. A schedule that is found goes back to Rails whole: `run!` claims it with an UPDATE, re-reads and locks the product,
// publishes it and queues the notice. An id Rails casts (a float, a word, nil, true, an array) goes back before any read.
// Golden: __fixtures__/publish-scheduled-product-job.golden.json (scripts/golden/publish-scheduled-product-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SCHEDULES = "product_publish_schedules";

export const publishScheduledProductJobWith = modelJob({ min: 1 }, async ([scheduleId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(scheduleId, "ProductPublishSchedule.find_by"));
  const [schedule] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${SCHEDULES}\`.*`)} FROM ${table(SCHEDULES)} WHERE ${column(SCHEDULES, "id")} = ${id} LIMIT 1`,
  );
  if (schedule === undefined) return;

  throw new HandBackToRuby("a due schedule is claimed, its product published and the notice queued");
});
export const publishScheduledProductJob = publishScheduledProductJobWith();
