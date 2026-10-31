// Port of app/models/product_cached_value.rb: scopes, validation and expire!. Not ported:
// the before_create assign_cached_values, which reads five Link metrics (successful_sales_count,
// remaining_for_sale_count, monthly_recurring_revenue, revenue_pending, total_usd_cents), so
// rows cannot be created from Node yet; see models/README.md.
import { Prisma, type ProductCachedValue } from "@prisma/client";

import { validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { abort } from "./runtime/errors.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { column } from "./sql.ts";

export const PRODUCT_CACHED_VALUES = "product_cached_values";

const product = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" } as const;

export const ProductCachedValues = defineModel<ProductCachedValue>({
  rubyClass: "ProductCachedValue",
  prismaModel: "ProductCachedValue",
  delegate: (tx) => tx.productCachedValue as never,
  validations: [validatesAssociationPresence<ProductCachedValue>(product)],
  beforeCreate: [
    {
      name: "assign_cached_values",
      run: () => {
        // Refuse rather than insert a row without its cached metrics.
        abort();
      },
    },
  ],
});

export const freshScope = () => Prisma.sql`${column(PRODUCT_CACHED_VALUES, "expired")} = ${false}`;
export const expiredScope = () => Prisma.sql`${column(PRODUCT_CACHED_VALUES, "expired")} = ${true}`;

// `#expire!`
export function expireProductCachedValue(record: ModelRecord<ProductCachedValue>) {
  return ProductCachedValues.updateBang(record, { expired: true });
}
