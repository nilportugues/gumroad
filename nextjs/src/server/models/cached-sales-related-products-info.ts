// Port of app/models/cached_sales_related_products_info.rb for UpdateCachedSalesRelatedProductsInfosJob: the required product and
// the counts format validation.
import type { CachedSalesRelatedProductsInfo } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const PRODUCT: BelongsTo = {
  name: "product",
  foreignKey: "product_id",
  targetTable: "links",
  targetModel: "Link",
};

// `{ product_id => sales_count }`; JSON stores the keys as strings, so they must read back as the integers they were.
function validCounts(counts: unknown): boolean {
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return false;
  return Object.entries(counts).every(
    ([key, count]) => key === String(Number.parseInt(key, 10)) && Number.isInteger(count),
  );
}

export const CachedSalesRelatedProductsInfos = defineModel<CachedSalesRelatedProductsInfo>({
  rubyClass: "CachedSalesRelatedProductsInfo",
  prismaModel: "CachedSalesRelatedProductsInfo",
  delegate: (tx) => tx.cachedSalesRelatedProductsInfo as never,
  validations: [
    belongsToRequired<CachedSalesRelatedProductsInfo>(PRODUCT),
    {
      name: "counts_has_valid_format",
      run(record) {
        if (!validCounts(record.get("counts"))) record.errors.add("counts", "has invalid format");
      },
    },
  ],
});
