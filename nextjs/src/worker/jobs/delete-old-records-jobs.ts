// Ports of the jobs that prune an append-only table in LIMITed batches until one comes back empty:
//   app/sidekiq/delete_old_sent_email_info_records_job.rb
//   app/sidekiq/delete_old_ping_deliveries_job.rb
//   app/sidekiq/delete_old_processed_stripe_events_job.rb
// Each checks ReplicaLagWatcher before every batch and recomputes the cutoff each time, as Ruby does.
import { Prisma } from "@prisma/client";

import { ago, type Duration } from "../../server/models/concerns/ruby-time.ts";
import { PING_DELIVERIES } from "../../server/models/ping-delivery.ts";
import { PROCESSED_STRIPE_EVENTS } from "../../server/models/processed-stripe-event.ts";
import { SENT_EMAIL_INFOS } from "../../server/models/sent-email-info.ts";
import { execute, selectRows, table } from "../../server/models/sql.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

async function deleteInBatches(tableName: string, validDuration: Duration, batchSize: number, deps: JobDeps) {
  for (;;) {
    await deps.watchReplicaLag();
    const deleted = await execute(Prisma.sql`DELETE FROM ${table(tableName)} WHERE (created_at < ${ago(validDuration, deps.now())}) LIMIT ${Prisma.raw(String(batchSize))}`);
    if (deleted === 0) break;
  }
}

const exists = async (sql: Prisma.Sql) => (await selectRows(sql)).length > 0;

// DeleteOldSentEmailInfoRecordsJob: any row at all, not just old ones, starts the loop.
export const deleteOldSentEmailInfoRecordsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  if (!(await exists(Prisma.sql`SELECT 1 AS one FROM ${table(SENT_EMAIL_INFOS)} LIMIT 1`))) return;
  await deleteInBatches(SENT_EMAIL_INFOS, { years: 1 }, 100, deps);
});

// Rows answer "did the ping for this sale go out?" in support tickets, which arrive within weeks.
export const deleteOldPingDeliveriesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const duration = { days: 90 };
  if (!(await exists(Prisma.sql`SELECT 1 AS one FROM ${table(PING_DELIVERIES)} WHERE (created_at < ${ago(duration, deps.now())}) LIMIT 1`))) return;
  await deleteInBatches(PING_DELIVERIES, duration, 1_000, deps);
});

// Rows only matter within Stripe's webhook redelivery window.
export const deleteOldProcessedStripeEventsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const duration = { days: 30 };
  if (!(await exists(Prisma.sql`SELECT 1 AS one FROM ${table(PROCESSED_STRIPE_EVENTS)} WHERE (created_at < ${ago(duration, deps.now())}) LIMIT 1`))) return;
  await deleteInBatches(PROCESSED_STRIPE_EVENTS, duration, 100, deps);
});

export const deleteOldSentEmailInfoRecordsJob = deleteOldSentEmailInfoRecordsJobWith();
export const deleteOldPingDeliveriesJob = deleteOldPingDeliveriesJobWith();
export const deleteOldProcessedStripeEventsJob = deleteOldProcessedStripeEventsJobWith();
