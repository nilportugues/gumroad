// Ports of the cleanup jobs built on ActiveRecord's batch iterators:
//   app/sidekiq/delete_processed_workflow_installment_schedule_intents_job.rb  (in_batches.delete_all)
//   app/sidekiq/delete_expired_product_cached_values_worker.rb                  (in_batches on a grouped relation)
//   app/sidekiq/delete_old_unused_events_worker.rb                              (find_in_batches with start/finish)
// The batches walk the primary key as ActiveRecord 8.1 does: ORDER BY id LIMIT n, then `id > last`,
// stopping after a short batch.
import { Prisma } from "@prisma/client";

import { advance, ago } from "../../server/models/concerns/ruby-time.ts";
import { EVENT_PERMITTED_NAMES, EVENTS } from "../../server/models/event.ts";
import { expiredScope, PRODUCT_CACHED_VALUES } from "../../server/models/product-cached-value.ts";
import { column, columnIn, columnNotIn, execute, selectRows, table } from "../../server/models/sql.ts";
import { WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS as INTENTS } from "../../server/models/workflow-installment-schedule-intent.ts";
import { modelJob } from "./support/job-deps.ts";

const limit = (n: number) => Prisma.raw(String(n));
const ids = (rows: Record<string, unknown>[], field = "id") => rows.map((row) => row[field]);

export const deleteProcessedWorkflowInstallmentScheduleIntentsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const BATCH = 1_000;
  const cutoff = Prisma.sql`${column(INTENTS, "processed_at")} < ${ago({ days: 30 }, deps.now())}`;
  let after: unknown = null;
  for (;;) {
    const where = after === null ? cutoff : Prisma.sql`${cutoff} AND ${column(INTENTS, "id")} > ${after}`;
    const batch = ids(await selectRows(Prisma.sql`SELECT ${column(INTENTS, "id")} FROM ${table(INTENTS)} WHERE ${where} ORDER BY ${column(INTENTS, "id")} ASC LIMIT ${limit(BATCH)}`));
    if (batch.length === 0) break;
    await execute(Prisma.sql`DELETE FROM ${table(INTENTS)} WHERE ${cutoff} AND ${columnIn(INTENTS, "id", batch)}`);
    if (batch.length < BATCH) break;
    after = batch.at(-1);
  }
});

// Deletes all expired rows except the newest per product. `expired` is still in the queries for
// their indexes, but the newest row is kept whether or not it is expired.
export const deleteExpiredProductCachedValuesWorkerWith = modelJob({ min: 0 }, async (_args, deps) => {
  const QUERY_BATCH_SIZE = 200;
  const DELETION_BATCH_SIZE = 100;
  const T = PRODUCT_CACHED_VALUES;
  let after: unknown = null;
  for (;;) {
    const where = after === null ? expiredScope() : Prisma.sql`${expiredScope()} AND ${column(T, "id")} > ${after}`;
    const batch = ids(
      await selectRows(
        Prisma.sql`SELECT ${column(T, "id")} FROM ${table(T)} WHERE ${where} GROUP BY ${column(T, "product_id")} ORDER BY ${column(T, "id")} ASC LIMIT ${limit(QUERY_BATCH_SIZE)}`,
      ),
    );
    if (batch.length === 0) break;

    const productIds = ids(
      await selectRows(Prisma.sql`SELECT DISTINCT ${column(T, "product_id")} FROM ${table(T)} WHERE ${expiredScope()} AND ${columnIn(T, "id", batch)} GROUP BY ${column(T, "product_id")}`),
      "product_id",
    );
    const keptMaxIds = ids(
      await selectRows(
        Prisma.sql`SELECT MAX(${column(T, "id")}) AS ${Prisma.raw("`maximum_id`")}, ${column(T, "product_id")} AS ${Prisma.raw("`product_cached_values_product_id`")} FROM ${table(T)} WHERE ${columnIn(T, "product_id", productIds)} GROUP BY ${column(T, "product_id")}`,
      ),
      "maximum_id",
    );
    for (;;) {
      await deps.watchReplicaLag();
      const deleted = await execute(
        Prisma.sql`DELETE FROM ${table(T)} WHERE ${expiredScope()} AND ${columnIn(T, "product_id", productIds)} AND ${columnNotIn(T, "id", keptMaxIds)} LIMIT ${limit(DELETION_BATCH_SIZE)}`,
      );
      if (deleted < DELETION_BATCH_SIZE) break;
    }

    if (batch.length < QUERY_BATCH_SIZE) break;
    after = batch.at(-1);
  }
});

// Deletes non-permitted events created between 2 months and 2 days ago and 2 months ago. The
// newest events stay for the admin "Show GUIDs" feature; the job runs daily, so two days of
// events is all it needs to review. Ruby takes `to:`/`from:` keywords, which a Sidekiq payload
// cannot carry, so the cron's no-argument call is the only form.
export const deleteOldUnusedEventsWorkerWith = modelJob({ min: 0 }, async (_args, deps) => {
  const BATCH = 100;
  const to = ago({ months: 2 }, deps.now());
  const from = advance(to, { days: -2 });
  const first = async (condition: Prisma.Sql, direction: "ASC" | "DESC") =>
    (await selectRows(Prisma.sql`SELECT ${Prisma.raw("`events`.*")} FROM ${table(EVENTS)} WHERE ${condition} ORDER BY ${column(EVENTS, "created_at")} ${Prisma.raw(direction)} LIMIT 1`))[0]?.id ?? null;
  const startId = await first(Prisma.sql`(created_at >= ${from})`, "ASC");
  const finishId = await first(Prisma.sql`(created_at <= ${to})`, "DESC");
  if (startId == null || finishId == null) return;

  const range = Prisma.sql`${column(EVENTS, "id")} >= ${startId} AND ${column(EVENTS, "id")} <= ${finishId}`;
  let after: unknown = null;
  for (;;) {
    const where = after === null ? range : Prisma.sql`${range} AND ${column(EVENTS, "id")} > ${after}`;
    const events = await selectRows<{ id: unknown; event_name: string | null }>(
      Prisma.sql`SELECT ${column(EVENTS, "id")}, ${column(EVENTS, "event_name")} FROM ${table(EVENTS)} WHERE ${where} ORDER BY ${column(EVENTS, "id")} ASC LIMIT ${limit(BATCH)}`,
    );
    if (events.length === 0) break;
    await deps.watchReplicaLag();
    // `events.to_h { [id, name] }` keeps the last name per id; ids are unique, so this is a filter.
    const toDelete = events.filter((event) => !EVENT_PERMITTED_NAMES.includes(event.event_name as string)).map((event) => event.id);
    if (toDelete.length > 0) await execute(Prisma.sql`DELETE FROM ${table(EVENTS)} WHERE ${columnIn(EVENTS, "id", toDelete)}`);
    if (events.length < BATCH) break;
    after = events.at(-1)!.id;
  }
});

export const deleteProcessedWorkflowInstallmentScheduleIntentsJob = deleteProcessedWorkflowInstallmentScheduleIntentsJobWith();
export const deleteExpiredProductCachedValuesWorker = deleteExpiredProductCachedValuesWorkerWith();
export const deleteOldUnusedEventsWorker = deleteOldUnusedEventsWorkerWith();
