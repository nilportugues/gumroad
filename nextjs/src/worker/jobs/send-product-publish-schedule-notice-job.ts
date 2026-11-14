// Port of app/sidekiq/send_product_publish_schedule_notice_job.rb up to `ProductPublishSchedule.notice_unsent.find_by(id:)`. A schedule
// whose notice is sent, or that is not published or failed, or that does not exist, finishes in Node. One whose notice is unsent goes back to
// Rails whole: it renders and delivers a CreatorMailer mail, then deletes the row or stamps `notice_sent_at`. An id Rails casts goes back
// before any read.
// Golden: __fixtures__/send-product-publish-schedule-notice-job.golden.json (scripts/golden/send-product-publish-schedule-notice-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { column, columnIn, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SCHEDULES = "product_publish_schedules";

export const sendProductPublishScheduleNoticeJobWith = modelJob({ min: 1 }, async ([scheduleId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(scheduleId, "ProductPublishSchedule.notice_unsent.find_by"));
  // `notice_unsent`: status in (published, failed) with no notice sent yet.
  const [schedule] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${SCHEDULES}\`.*`)} FROM ${table(SCHEDULES)} WHERE ${columnIn(SCHEDULES, "status", ["published", "failed"])} AND ${column(SCHEDULES, "notice_sent_at")} IS NULL AND ${column(SCHEDULES, "id")} = ${id} LIMIT 1`,
  );
  if (schedule === undefined) return;

  throw new HandBackToRuby("the schedule's notice is mailed through CreatorMailer, then the row is deleted or stamped");
});
export const sendProductPublishScheduleNoticeJob = sendProductPublishScheduleNoticeJobWith();
