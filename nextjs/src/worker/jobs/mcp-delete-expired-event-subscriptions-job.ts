// Port of app/sidekiq/mcp/delete_expired_event_subscriptions_job.rb. Golden: __fixtures__/mcp-delete-expired-event-subscriptions-job.golden.json
// (scripts/golden/mcp-delete-expired-event-subscriptions-job.rb).
import { Prisma } from "@prisma/client";

import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SUBSCRIPTIONS = "mcp_event_subscriptions";
const SELLERS_PER_BATCH = 100;

// McpEventSubscription.expired: the time is taken when the relation is built, so every statement of a pass sees the clock as it is then.
const expired = (now: Date) => Prisma.sql`(mcp_event_subscriptions.expires_at <= ${now})`;

export const mcpDeleteExpiredEventSubscriptionsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  for (;;) {
    const rows = await selectRows<{ user_id: bigint | number }>(
      Prisma.sql`SELECT DISTINCT ${column(SUBSCRIPTIONS, "user_id")} FROM ${table(SUBSCRIPTIONS)} WHERE ${expired(deps.now())} LIMIT ${Prisma.raw(String(SELLERS_PER_BATCH))}`,
    );
    if (rows.length === 0) break;

    await deps.watchReplicaLag();
    for (const { user_id: userId } of rows) {
      // McpEventSubscription.lock_seller! (the seller lock a subscribe holds), then the delete.
      await transaction(async () => {
        await selectRows(
          Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1 FOR UPDATE`,
        );
        await execute(
          Prisma.sql`DELETE FROM ${table(SUBSCRIPTIONS)} WHERE ${expired(deps.now())} AND ${column(SUBSCRIPTIONS, "user_id")} = ${userId}`,
        );
      });
    }
  }
});
export const mcpDeleteExpiredEventSubscriptionsJob = mcpDeleteExpiredEventSubscriptionsJobWith();
