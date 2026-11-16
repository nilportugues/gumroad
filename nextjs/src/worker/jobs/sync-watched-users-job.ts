// Port of app/sidekiq/sync_watched_users_job.rb and WatchedUser#sync!: every alive watched user gets its revenue (two Elasticsearch
// searches) and unpaid balance refreshed. A failure for one is reported and the sweep goes on, so nothing here hands back.
// Golden: __fixtures__/sync-watched-users-job.golden.json (scripts/golden/sync-watched-users-job.rb).
import { Prisma, type User, type WatchedUser } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { setAssociation } from "../../server/models/concerns/rails-validations.ts";
import { findById } from "../../server/models/row-reads.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import { unpaidBalanceCents } from "../../server/models/user-balance-stats.ts";
import { WATCHED_USER_USER, WATCHED_USERS, WatchedUsers } from "../../server/models/watched-user.ts";
import { salesCentsTotal } from "../../server/search/purchase-sales.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

// find_each's default batch size
const BATCH_SIZE = 1_000;

// A Ruby NoMethodError on nil, as the message the error report carries.
class NoMethodError extends Error {
  constructor(method: string) {
    super(`undefined method '${method}' for nil`);
    this.name = "NoMethodError";
  }
}

export type SyncDeps = { notify: (error: unknown, context: Record<string, unknown>) => void };

export const syncWatchedUsersJobWith = (overrides: Partial<JobDeps> = {}, sync: Partial<SyncDeps> = {}) => {
  const notify = sync.notify ?? ((error, context) => notifyError(error, context));
  return modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    await findInBatches<WatchedUser>(
      WATCHED_USERS,
      Prisma.sql`${column(WATCHED_USERS, "deleted_at")} IS NULL`,
      BATCH_SIZE,
      async (watchedUsers) => {
        for (const row of watchedUsers) {
          try {
            const user = await findById<User>("User", row.user_id);
            if (user === null) throw new NoMethodError("sales_cents_total");
            const revenue = await salesCentsTotal(user.id);
            const unpaidBalance = await unpaidBalanceCents(user.id);
            // The loaded user stays on the record for the belongs_to validation the update runs.
            const record = WatchedUsers.load(row);
            setAssociation(record, WATCHED_USER_USER.name, row.user_id, user);
            await WatchedUsers.updateBang(
              record,
              { revenue_cents: BigInt(revenue), unpaid_balance_cents: BigInt(unpaidBalance), last_synced_at: deps.now() },
              { now: deps.now },
            );
          } catch (error) {
            notify(error, { context: { watched_user_id: row.id } });
          }
        }
      },
    );
  })(overrides);
};

export const syncWatchedUsersJob = syncWatchedUsersJobWith();
