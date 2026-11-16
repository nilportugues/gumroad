// Ports of app/sidekiq/exports/sales/compile_chunks_worker.rb and process_chunk_worker.rb up to the export itself. Each opens with a
// `find` (the export; the chunk and then its export) that runs in Node and ends the job on a missing record. What follows builds the
// purchases data through PurchaseExportService, compiles it into a CSV that is mailed, and updates or deletes chunks, so a record that
// is found goes back to Rails before any of it. An id Rails casts goes back before any read.
// Golden: __fixtures__/exports-sales-compile-chunks-worker.golden.json and exports-sales-process-chunk-worker.golden.json
// (scripts/golden/exports-sales-compile-chunks-worker.rb, exports-sales-process-chunk-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const compileChunksWorkerWith = modelJob({ min: 1 }, async ([exportId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(exportId, "SalesExport.find"));
  await findByIdBang("SalesExport", id);

  throw new HandBackToRuby("the chunks are compiled, mailed and deleted");
});
export const compileChunksWorker = compileChunksWorkerWith();

export const processChunkWorkerWith = modelJob({ min: 1 }, async ([chunkId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(chunkId, "SalesExportChunk.find"));
  const chunk = await findByIdBang<{ export_id: bigint | null }>("SalesExportChunk", id);
  // `@chunk.export`; a chunk whose export is gone carries on in Rails, which fails in its own way later.
  await findById("SalesExport", chunk.export_id);

  throw new HandBackToRuby("the chunk's purchases are exported and the chunk updated");
});
export const processChunkWorker = processChunkWorkerWith();
