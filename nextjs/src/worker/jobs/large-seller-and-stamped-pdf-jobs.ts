// Ports of:
//   app/sidekiq/update_large_sellers_sales_count_job.rb
//   app/sidekiq/expire_stamped_pdfs_job.rb
import { Prisma, type LargeSeller, type StampedPdf } from "@prisma/client";

import { ago } from "../../server/models/concerns/ruby-time.ts";
import { LARGE_SELLERS, LargeSellers, salesCountSql } from "../../server/models/large-seller.ts";
import { castRow, column, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { aliveScope, preloadAssociations, STAMPED_PDFS, StampedPdfDeletable, StampedPdfs } from "../../server/models/stamped-pdf.ts";
import { modelJob } from "./support/job-deps.ts";

export const updateLargeSellersSalesCountJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  await findInBatches(LARGE_SELLERS, null, 100, async (rows) => {
    for (const row of rows) {
      const largeSeller = LargeSellers.load(castRow<LargeSeller>("LargeSeller", row));
      const userId = largeSeller.get("user_id");
      const users = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
      if (users.length === 0) continue;

      const [count] = await selectRows<Record<string, unknown>>(salesCountSql(userId));
      const currentSalesCount = Number(Object.values(count!)[0]);
      if (currentSalesCount !== largeSeller.get("sales_count")) {
        await LargeSellers.updateBang(largeSeller, { sales_count: currentSalesCount }, { now: deps.now });
      }
    }
  });
});

const RECENTNESS_LIMIT = { months: 3 };
const BATCH_SIZE = 100;

export const expireStampedPdfsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  for (;;) {
    await deps.watchReplicaLag();
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`\`${STAMPED_PDFS}\`.*`)} FROM ${table(STAMPED_PDFS)} WHERE ${aliveScope()} AND ${column(STAMPED_PDFS, "created_at")} <= ${ago(RECENTNESS_LIMIT, deps.now())} LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
    );
    if (rows.length === 0) break;
    const records = rows.map((row) => StampedPdfs.load(castRow<StampedPdf>("StampedPdf", row)));
    await preloadAssociations(records);
    for (const record of records) await StampedPdfDeletable.markDeletedBang(record, { now: deps.now });
  }
});

export const updateLargeSellersSalesCountJob = updateLargeSellersSalesCountJobWith();
export const expireStampedPdfsJob = expireStampedPdfsJobWith();
