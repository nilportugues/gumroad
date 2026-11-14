// Port of app/sidekiq/exports/sales/create_and_enqueue_chunks_worker.rb up to the first write. The `find` of the export runs in Node
// and ends the job on a missing record, and so does the read that starts the stale-chunk delete (`chunks.in_batches(of: 1)`); what
// follows deletes those chunks, scrolls Elasticsearch for the export's purchases, inserts a chunk per thousand and enqueues them, so
// an export that is found goes back to Rails whole. An id that is not an Integer goes back before any read: Rails casts a String,
// a Float and digits with letters in ways of its own, and words its RecordNotFound by the type.
// Golden: __fixtures__/exports-sales-create-and-enqueue-chunks-worker.golden.json
// (scripts/golden/exports-sales-create-and-enqueue-chunks-worker.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findByIdBang } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const CHUNKS = "sales_export_chunks";

export const createAndEnqueueChunksWorkerWith = modelJob({ min: 1 }, async ([exportId]) => {
  // A Sidekiq JSON Integer past 2**53 is a bigint and a Float a RubyFloat, so a number is a safe Integer.
  if (typeof exportId !== "number") throw new HandBackToRuby("the export id is not an Integer");
  const id = BigInt(exportId);
  await findByIdBang("SalesExport", id);

  // `@export.chunks.in_batches(of: 1)` reads one id at a time and deletes it; the first read is the last Node can make before a write.
  await selectRows(
    Prisma.sql`SELECT ${column(CHUNKS, "id")} FROM ${table(CHUNKS)} WHERE ${column(CHUNKS, "export_id")} = ${id} ORDER BY ${column(CHUNKS, "id")} ASC LIMIT 1`,
  );

  throw new HandBackToRuby(
    "the stale chunks are deleted, the purchases scrolled from Elasticsearch and the chunks created",
  );
});
export const createAndEnqueueChunksWorker = createAndEnqueueChunksWorkerWith();
