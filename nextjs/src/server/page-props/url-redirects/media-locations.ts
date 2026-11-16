import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { jsonTime } from "../../presenters/mobile-serializers.ts";

export type MediaLocationJson = { location: number; unit: string | null; timestamp: string | null };

// MediaLocation.max_consumed_at_by_file(purchase_id:).index_by(&:product_file_id), as_json'd. Two rows sharing the latest
// consumed_at come back in no defined order, so that case is Rails'.
export async function latestMediaLocations(purchaseId: bigint): Promise<Map<bigint, MediaLocationJson>> {
  const rows = await db.mediaLocation.findMany({ where: { purchase_id: purchaseId } });
  const latest = new Map<bigint, typeof rows>();
  for (const row of rows) {
    const current = latest.get(row.product_file_id);
    const at = row.consumed_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    const best = current?.[0]?.consumed_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (!current || at > best) latest.set(row.product_file_id, [row]);
    else if (at === best) current.push(row);
  }
  const result = new Map<bigint, MediaLocationJson>();
  for (const [fileId, tied] of latest) {
    if (tied.length > 1) throw new HandBackToRails("media locations that share the latest consumed_at");
    const row = tied[0]!;
    result.set(fileId, { location: row.location, unit: row.unit, timestamp: jsonTime(row.consumed_at) });
  }
  return result;
}
