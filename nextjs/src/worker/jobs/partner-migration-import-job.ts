// Port of app/sidekiq/partner_migration_import_job.rb up to the claim. Under the row lock, a migration that is no longer claimed ends the
// job when it has not completed; one that has completed re-enqueues its notification, and a claimed one is stamped with
// `import_started_at` and imported (products, avatar, media): both go back to Rails whole before any write. The retries-exhausted block
// marks the migration failed and reports to ErrorNotifier, so it goes back whole as well. An id Rails casts goes back before any read.
// Golden: __fixtures__/partner-migration-import-job.golden.json (scripts/golden/partner-migration-import-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

const MIGRATIONS = "partner_migrations";
const STATUS_CLAIMED = "claimed";

type Migration = { id: bigint | number; status: string; completed_at: Date | null };

const row = (id: bigint, suffix = "") =>
  Prisma.sql`SELECT ${Prisma.raw("`partner_migrations`.*")} FROM ${table(MIGRATIONS)} WHERE ${column(MIGRATIONS, "id")} = ${id} LIMIT 1${Prisma.raw(suffix)}`;

export const partnerMigrationImportJobWith = modelJob({ min: 1, max: 1 }, async ([idArg]) => {
  // `PartnerMigration.find(nil)` raises before any statement.
  if (idArg === null) throw new RecordNotFound("Couldn't find PartnerMigration without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(idArg, "PartnerMigration.find"));

  // ApplicationRecord.connected_to(role: :writing)
  await connectedTo("writing", async () => {
    const [found] = await selectRows<Migration>(row(id));
    if (found === undefined) throw new RecordNotFound(`Couldn't find PartnerMigration with 'id'=${String(id)}`);

    const migration = await transaction(async () => {
      // with_lock: `lock!` reloads the migration FOR UPDATE.
      const [locked] = await selectRows<Migration>(row(id, " FOR UPDATE"));
      if (locked === undefined) throw new HandBackToRuby("a migration that vanished under its lock");
      if (locked.status === STATUS_CLAIMED)
        throw new HandBackToRuby("the import writes import_started_at and creates the products");
      return locked;
    });
    // Outside the lock, as in Ruby: a completed migration retries a failed notification enqueue; one still running has nothing to do.
    if (migration.completed_at !== null)
      throw new HandBackToRuby("the notification job is enqueued for a completed migration");
  });
});
export const partnerMigrationImportJob = partnerMigrationImportJobWith();

export const partnerMigrationImportJobRetriesExhausted: RetriesExhausted = () => {
  throw new HandBackToRuby("the retries-exhausted block marks the migration failed and reports to ErrorNotifier");
};
