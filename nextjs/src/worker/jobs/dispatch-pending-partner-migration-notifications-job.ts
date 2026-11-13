// Port of app/sidekiq/dispatch_pending_partner_migration_notifications_job.rb: every finished (completed or failed) partner migration
// of a live, unsuspended user with an address, not yet notified, whose last failed address is not the current one and that finished
// more than 10 minutes ago queues PartnerMigrationNotificationJob. `find_each` pushes batch by batch, as Rails does.
// Golden: __fixtures__/dispatch-pending-partner-migration-notifications-job.golden.json
// (scripts/golden/dispatch-pending-partner-migration-notifications-job.rb).
import { Prisma } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, columnIn, columnNotIn, findInBatches, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const MIGRATIONS = "partner_migrations";
const USERS = "users";
const STATUS_COMPLETED = "completed";
const STATUS_FAILED = "failed";
const SUSPENDED_RISK_STATES = ["suspended_for_fraud", "suspended_for_tos_violation"];
const NOTIFICATION_DELAY = { minutes: 10 };
const FIND_EACH_BATCH_SIZE = 1_000;
const NOTIFICATION_JOB = "PartnerMigrationNotificationJob";

export const dispatchPendingPartnerMigrationNotificationsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  // `where(completed_at: ..10.minutes.ago)` takes the time when the relation is built, before the first batch.
  const completedBefore = ago(NOTIFICATION_DELAY, deps.now());
  const where = Prisma.sql`${column(USERS, "deleted_at")} IS NULL AND (${columnNotIn(USERS, "user_risk_state", SUSPENDED_RISK_STATES)}) AND (COALESCE(NULLIF(users.unconfirmed_email, ''), NULLIF(users.email, '')) IS NOT NULL) AND ${columnIn(MIGRATIONS, "status", [STATUS_COMPLETED, STATUS_FAILED])} AND ${column(MIGRATIONS, "notified_at")} IS NULL AND (notification_failed_email IS NULL OR notification_failed_email != COALESCE(NULLIF(users.unconfirmed_email, ''), users.email)) AND ${column(MIGRATIONS, "completed_at")} <= ${completedBefore}`;
  const joins = Prisma.sql`INNER JOIN ${table(USERS)} ON ${column(USERS, "id")} = ${column(MIGRATIONS, "user_id")}`;
  await findInBatches<{ id: bigint | number }>(
    MIGRATIONS,
    where,
    FIND_EACH_BATCH_SIZE,
    async (rows) => {
      for (const migration of rows) await performAsync(NOTIFICATION_JOB, [migration.id]);
    },
    null,
    joins,
  );
});

export const dispatchPendingPartnerMigrationNotificationsJob = dispatchPendingPartnerMigrationNotificationsJobWith();
