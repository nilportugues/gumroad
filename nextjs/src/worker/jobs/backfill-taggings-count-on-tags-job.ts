// Port of app/sidekiq/backfill_taggings_count_on_tags_job.rb and Onetime::BackfillTaggingsCountOnTags.process with its defaults.
// Golden: __fixtures__/backfill-taggings-count-on-tags-job.golden.json (scripts/golden/backfill-taggings-count-on-tags-job.rb).
import { Prisma } from "@prisma/client";

import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, columnIn, execute, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const TAGS = "tags";
const PRODUCT_TAGGINGS = "product_taggings";
const BATCH_SIZE = 1_000;
// Rails sends the default start id quoted.
const START_TAG_ID = "0";

type CountRow = { count_all: bigint | number; product_taggings_tag_id: number | null };

export const backfillTaggingsCountOnTagsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const scope = Prisma.sql`(id >= ${START_TAG_ID})`;
  await findInBatches<{ id: number }>(
    TAGS,
    scope,
    BATCH_SIZE,
    async (batch) => {
      await deps.watchReplicaLag();
      const batchIds = batch.map((r) => r.id);
      const maxId = await transaction(async (): Promise<number | null> => {
        // The row locks come before the count so a live tagging write cannot slip between the two.
        const ids = (
          await selectRows<{ id: number }>(
            Prisma.sql`SELECT ${column(TAGS, "id")} FROM ${table(TAGS)} WHERE ${scope} AND ${columnIn(TAGS, "id", batchIds)} FOR UPDATE`,
          )
        ).map((r) => r.id);
        if (ids.length === 0) return null;

        const counts = new Map<number, number>();
        const rows = await selectRows<CountRow>(
          Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`count_all`")}, ${column(PRODUCT_TAGGINGS, "tag_id")} AS ${Prisma.raw("`product_taggings_tag_id`")} FROM ${table(PRODUCT_TAGGINGS)} WHERE ${columnIn(PRODUCT_TAGGINGS, "tag_id", ids)} GROUP BY ${column(PRODUCT_TAGGINGS, "tag_id")}`,
        );
        for (const row of rows) counts.set(Number(row.product_taggings_tag_id), Number(row.count_all));

        const byCount = new Map<number, number[]>();
        for (const id of ids) {
          const count = counts.get(id) ?? 0;
          byCount.set(count, [...(byCount.get(count) ?? []), id]);
        }
        for (const [count, tagIds] of byCount) {
          await execute(
            Prisma.sql`UPDATE ${table(TAGS)} SET ${column(TAGS, "taggings_count")} = ${count} WHERE ${columnIn(TAGS, "id", tagIds)}`,
          );
        }
        return Math.max(...ids);
      });
      if (maxId !== null) process.stdout.write(`Tag taggings_count backfill: reached id=${maxId}\n`);
    },
    column(TAGS, "id"),
  );
});
export const backfillTaggingsCountOnTagsJob = backfillTaggingsCountOnTagsJobWith();
