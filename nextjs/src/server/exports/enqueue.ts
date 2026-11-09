// The perform_async calls that start an export. The job bodies are WS-30; these only put the job on the queue
// through enqueue(), which takes the same unique lock Sidekiq would.
import { type JsonValue, enqueue } from "../jobs/enqueue.ts";
import type { AudienceOptions } from "./audience-export.ts";
import { runsSynchronously } from "./affiliate-export.ts";

// Exports::AudienceExportWorker.perform_async(seller.id, recipient.id, options)
export async function enqueueAudienceExport(sellerId: bigint, recipientId: bigint, options: AudienceOptions): Promise<string | null> {
  const payload: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) payload[key] = value;
  }
  return enqueue("Exports::AudienceExportWorker", [sellerId, recipientId, payload]);
}

// AffiliateExportService.export: builds inline below the threshold (the caller does that), otherwise enqueues
// and reports that nothing was returned, as the Ruby does with `false`.
export async function exportAffiliatesOrEnqueue(args: {
  sellerId: bigint;
  recipientId: bigint;
  liveAffiliateCount: number;
}): Promise<{ synchronous: true } | { synchronous: false }> {
  if (runsSynchronously(args.liveAffiliateCount)) return { synchronous: true };
  await enqueue("Exports::AffiliateExportWorker", [args.sellerId, args.recipientId]);
  return { synchronous: false };
}

// The chunked sales export: PurchaseExportService.export creates the SalesExport row first, then calls this.
export async function enqueueSalesExportChunks(salesExportId: bigint): Promise<string | null> {
  return enqueue("Exports::Sales::CreateAndEnqueueChunksWorker", [salesExportId]);
}
