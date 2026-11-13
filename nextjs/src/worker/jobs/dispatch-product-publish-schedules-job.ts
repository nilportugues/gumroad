// Port of app/sidekiq/dispatch_product_publish_schedules_job.rb up to `recover_stale_claim!`. It reads the ids of the due schedules and
// scans the stale claims; a stale claim (a worker died between the claim and the outcome) is resolved by reading the product and writing the
// outcome, so the whole run goes back to Rails with nothing pushed yet. Without one, Node queues PublishScheduledProductJob for each due
// schedule and SendProductPublishScheduleNoticeJob for each notice still unsent after 2 minutes, in the order Rails does.
// Golden: __fixtures__/dispatch-product-publish-schedules-job.golden.json (scripts/golden/dispatch-product-publish-schedules-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SCHEDULES = "product_publish_schedules";
const CLAIM_TIMEOUT = { minutes: 15 };
const NOTICE_GRACE = { minutes: 2 };
const FIND_EACH_BATCH_SIZE = 1_000;
const PUBLISH_JOB = "PublishScheduledProductJob";
const NOTICE_JOB = "SendProductPublishScheduleNoticeJob";

const ids = async (where: Prisma.Sql) =>
  (
    await selectRows<{ id: bigint | number }>(
      Prisma.sql`SELECT ${column(SCHEDULES, "id")} FROM ${table(SCHEDULES)} WHERE ${where}`,
    )
  ).map((row) => row.id);

export const dispatchProductPublishSchedulesJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  // `due`: scheduled and publish_at up to now.
  const due = await ids(
    Prisma.sql`${column(SCHEDULES, "status")} = ${"scheduled"} AND ${column(SCHEDULES, "publish_at")} <= ${deps.now()}`,
  );

  // `stale_claims`: publishing, claimed CLAIM_TIMEOUT ago or earlier.
  await findInBatches(
    SCHEDULES,
    Prisma.sql`${column(SCHEDULES, "status")} = ${"publishing"} AND ${column(SCHEDULES, "claimed_at")} <= ${ago(CLAIM_TIMEOUT, deps.now())}`,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a stale claim to recover");
    },
  );

  // `notice_unsent` for a minute or two: published or failed, no notice sent, not touched for NOTICE_GRACE.
  const unsent = await ids(
    Prisma.sql`${columnIn(SCHEDULES, "status", ["published", "failed"])} AND ${column(SCHEDULES, "notice_sent_at")} IS NULL AND ${column(SCHEDULES, "updated_at")} <= ${ago(NOTICE_GRACE, deps.now())}`,
  );

  for (const id of due) await performAsync(PUBLISH_JOB, [id]);
  for (const id of unsent) await performAsync(NOTICE_JOB, [id]);
});
export const dispatchProductPublishSchedulesJob = dispatchProductPublishSchedulesJobWith();
