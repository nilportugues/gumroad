// PurchaseExportService.export for the chunked path (force_async: true): the SalesExport row, whose `query` column holds the
// Elasticsearch query as YAML, then the job that scrolls it. The synchronous CSV below SYNCHRONOUS_EXPORT_THRESHOLD is not
// reachable from the API, which always forces the async path.
import { Prisma } from "@prisma/client";

import type { YamlValue } from "../models/concerns/psych.ts";
import { yamlColumn } from "../models/concerns/serialized-columns.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { enqueueSalesExportChunks } from "./enqueue.ts";
import { SYNCHRONOUS_EXPORT_THRESHOLD } from "./purchase-export.ts";

// Purchase::NON_GIFT_SUCCESS_STATES
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
const DAY_MS = 86_400_000;

export type SalesExportFilters = {
  // "YYYY-MM-DD" days, read as UTC days (the API does not pass in_seller_time_zone)
  startDate?: string;
  endDate?: string;
  productIds?: number[];
};

// `search_service.query.deep_stringify_keys`
export function salesExportQuery(sellerId: bigint | number, filters: SalesExportFilters): YamlValue {
  const startTime = filters.startDate === undefined ? undefined : new Date(`${filters.startDate}T00:00:00Z`);
  // created_before is exclusive: the next day's midnight keeps the last second of the end date
  const endTime =
    filters.endDate === undefined ? undefined : new Date(Date.parse(`${filters.endDate}T00:00:00Z`) + DAY_MS);
  const service = new PurchaseSearchService({
    seller: sellerId,
    state: NON_GIFT_SUCCESS_STATES,
    exclude_not_charged_non_free_trial_purchases: true,
    exclude_bundle_product_purchases: true,
    any_products_or_variants: { products: filters.productIds, variants: undefined },
    created_on_or_after: startTime,
    created_before: endTime,
    size: SYNCHRONOUS_EXPORT_THRESHOLD,
  });
  return service.body.query as unknown as YamlValue;
}

const queryColumn = yamlColumn("query", "Hash");

// SalesExport.create!(recipient:, query:) then Exports::Sales::CreateAndEnqueueChunksWorker.perform_async(export.id)
export async function queueSalesExport(
  recipientId: bigint | number,
  query: YamlValue,
  now: Date = new Date(),
): Promise<bigint> {
  const stamp = now.toISOString().replace("T", " ").replace("Z", "000");
  const exports = "sales_exports";
  const id = await transaction(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(exports)} (${column(exports, "recipient_id")}, ${column(exports, "query")}, ${column(exports, "created_at")}, ${column(exports, "updated_at")}) VALUES (${recipientId}, ${queryColumn.dump(query)}, ${stamp}, ${stamp})`,
    );
    const [row] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
    return BigInt(row!.id);
  });
  await enqueueSalesExportChunks(id);
  return id;
}
