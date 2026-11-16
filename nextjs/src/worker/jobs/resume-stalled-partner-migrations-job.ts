// Port of app/sidekiq/resume_stalled_partner_migrations_job.rb up to the `stalled` scan. No stalled migration finishes in Node. The first
// one goes back to Rails whole: `resume_stalled_import!` locks the row and either queues PartnerMigrationImportJob (releasing its lock if
// needed) or fails the migration, notifying Sentry.
// Golden: __fixtures__/resume-stalled-partner-migrations-job.golden.json (scripts/golden/resume-stalled-partner-migrations-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const MIGRATIONS = "partner_migrations";
const STATUS_CLAIMED = "claimed";
// `PartnerMigration::STALLED_AFTER`: twice `RemoteFileTransfer::MAX_DOWNLOAD_DURATION` (3 hours).
const STALLED_AFTER = { hours: 6 };
const FIND_EACH_BATCH_SIZE = 1_000;

export const resumeStalledPartnerMigrationsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  // `stalled`: a claimed migration whose import started and that has not been touched for STALLED_AFTER.
  const stalledBefore = ago(STALLED_AFTER, deps.now());
  const where = Prisma.sql`${column(MIGRATIONS, "status")} = ${STATUS_CLAIMED} AND ${column(MIGRATIONS, "updated_at")} < ${stalledBefore} AND ${column(MIGRATIONS, "import_started_at")} IS NOT NULL`;
  await findInBatches(
    MIGRATIONS,
    where,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a stalled partner migration to resume");
    },
    Prisma.raw(`\`${MIGRATIONS}\`.\`id\``),
  );
});
export const resumeStalledPartnerMigrationsJob = resumeStalledPartnerMigrationsJobWith();
