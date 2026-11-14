// Port of app/sidekiq/partner_migration_notification_job.rb up to the email. Under the head part's row lock, the parts are read and
// the job either ends (a part unfinished, everything notified, no active user with an address, the address already rejected) or marks
// every part notified without mailing (the account setup email is still usable and nothing failed, or a failure was already mailed).
// The result email (`CreatorMailer#partner_migration_finished`, then `notified_at`, `failure_notified_at` and the SMTP rescue) goes
// back to Rails whole; the transaction has written nothing by then.
// Golden: __fixtures__/partner-migration-notification-job.golden.json (scripts/golden/partner-migration-notification-job.rb).
import { createHash } from "node:crypto";

import { Prisma, type User } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { advance } from "../../server/models/concerns/ruby-time.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../../server/models/sql.ts";
import { RISK_STATES } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const MIGRATIONS = "partner_migrations";
const STATUS_FAILED = "failed";
// PartnerMigration::ACCOUNT_SETUP_EXPIRES_IN (EXPIRES_IN)
const ACCOUNT_SETUP_EXPIRES_IN = { days: 7 };
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

type Migration = {
  id: bigint | number;
  oauth_application_id: bigint | number;
  external_user_id: string;
  part: number;
  user_id: bigint | number | null;
  claimed_at: Date | null;
  account_created: unknown;
  account_setup_token_digest: string | null;
  account_setup_password_digest: string | null;
  failure_notified_at: Date | null;
  notification_failed_email: string | null;
};

const present = (value: string | null): value is string => value !== null && !BLANK.test(value);
const isSuspended = (user: User) =>
  (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(user.user_risk_state);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// `parts`: the migration's catalog, one row per part.
const partsOf = (m: Migration) =>
  Prisma.sql`${column(MIGRATIONS, "oauth_application_id")} = ${m.oauth_application_id} AND ${column(MIGRATIONS, "external_user_id")} = ${m.external_user_id}`;
const byPart = Prisma.sql` ORDER BY ${column(MIGRATIONS, "part")} ASC`;

async function findMigration(id: bigint | null): Promise<Migration | null> {
  if (id === null) {
    const [row] = await selectRows<Migration>(
      Prisma.sql`SELECT ${Prisma.raw("`partner_migrations`.*")} FROM ${table(MIGRATIONS)} WHERE ${column(MIGRATIONS, "id")} IS NULL LIMIT 1`,
    );
    return row ?? null;
  }
  const [row] = await selectRows<Migration>(
    Prisma.sql`SELECT ${Prisma.raw("`partner_migrations`.*")} FROM ${table(MIGRATIONS)} WHERE ${column(MIGRATIONS, "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `head`: part 1 holds the notification state.
async function headOf(part: Migration): Promise<Migration> {
  if (part.part === 1) return part;
  const [row] = await selectRows<Migration>(
    Prisma.sql`SELECT ${Prisma.raw("`partner_migrations`.*")} FROM ${table(MIGRATIONS)} WHERE ${partsOf(part)} AND ${column(MIGRATIONS, "part")} = 1 LIMIT 1`,
  );
  if (row === undefined) {
    throw new RecordNotFound(
      "Couldn't find PartnerMigration with [WHERE `partner_migrations`.`oauth_application_id` = ? AND `partner_migrations`.`external_user_id` = ? AND `partner_migrations`.`part` = ?]",
    );
  }
  return row;
}

export const partnerMigrationNotificationJobWith = modelJob({ min: 1, max: 1 }, async ([idArg], deps) => {
  const id = await beforeSideEffects(() => (idArg === null ? null : recordIdFrom(idArg, "PartnerMigration.find_by")));

  // ApplicationRecord.connected_to(role: :writing)
  await beforeSideEffects(() =>
    connectedTo("writing", async () => {
      const part = await findMigration(id);
      if (part === null) return;
      const head = await headOf(part);

      await transaction(async () => {
        // with_lock: `lock!` reloads the head FOR UPDATE.
        const [locked] = await selectRows<Migration>(
          Prisma.sql`SELECT ${Prisma.raw("`partner_migrations`.*")} FROM ${table(MIGRATIONS)} WHERE ${column(MIGRATIONS, "id")} = ${head.id} LIMIT 1 FOR UPDATE`,
        );
        if (locked === undefined) throw new HandBackToRuby("a head part that vanished under its lock");
        const migration = locked;

        const parts = await selectRows<{ status: string; completed_at: Date | null; notified_at: Date | null }>(
          Prisma.sql`SELECT ${column(MIGRATIONS, "status")}, ${column(MIGRATIONS, "completed_at")}, ${column(MIGRATIONS, "notified_at")} FROM ${table(MIGRATIONS)} WHERE ${partsOf(migration)}${byPart} FOR UPDATE`,
        );
        if (!parts.every((p) => p.completed_at !== null) || !parts.some((p) => p.notified_at === null)) return;

        const notifyParts = () =>
          execute(
            Prisma.sql`UPDATE ${table(MIGRATIONS)} SET ${column(MIGRATIONS, "notified_at")} = ${deps.now()} WHERE ${partsOf(migration)}${byPart}`,
          );
        const failed = parts.some((p) => p.status === STATUS_FAILED);

        // `migration.user`, loaded once.
        let user: Promise<User | null> | undefined;
        const loadUser = () =>
          (user ??= findById<User>("User", migration.user_id === null ? null : BigInt(migration.user_id)));
        const accountActive = (u: User) => u.deleted_at === null && !isSuspended(u);

        // account_setup_open?: account_setup_pending? && !account_setup_expired?
        const accountSetupPending = async () => {
          if (!Number(migration.account_created) || !present(migration.account_setup_token_digest)) return false;
          const u = await loadUser();
          if (u === null || !accountActive(u)) return false;
          if (u.sign_in_count === null) throw new TypeError("undefined method 'zero?' for nil");
          return u.sign_in_count === 0 && sha256(u.encrypted_password) === migration.account_setup_password_digest;
        };
        const accountSetupOpen =
          (await accountSetupPending()) &&
          !(
            migration.claimed_at === null ||
            advance(migration.claimed_at, ACCOUNT_SETUP_EXPIRES_IN).getTime() <= deps.now().getTime()
          );

        // The setup email already said the products are importing: the seller hears again only when something needs attention.
        if (accountSetupOpen && !failed) return void (await notifyParts());
        // A failure is emailed once; a later success still is.
        if (failed && migration.failure_notified_at !== null) return void (await notifyParts());
        const u = await loadUser();
        if (u === null || !accountActive(u)) return;
        const recipient = present(u.unconfirmed_email) ? u.unconfirmed_email : present(u.email) ? u.email : null;
        if (recipient === null) return;
        if (migration.notification_failed_email === recipient) return;

        throw new HandBackToRuby("the result email");
      });
    }),
  );
});
export const partnerMigrationNotificationJob = partnerMigrationNotificationJobWith();
