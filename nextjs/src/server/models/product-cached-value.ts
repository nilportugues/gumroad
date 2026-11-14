// Port of app/models/product_cached_value.rb: scopes, validation, before_create assign_cached_values and expire!.
// Golden: worker/jobs/__fixtures__/cache-product-data-worker.golden.json (scripts/golden/cache-product-data-worker.rb).
import { Prisma, type Link, type ProductCachedValue } from "@prisma/client";

import { associationCache, validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { rubyFloatRoundDigits } from "./concerns/ruby-numeric.ts";
import {
  monthlyRecurringRevenue,
  remainingForSaleCount,
  revenuePending,
  successfulSalesCount,
  totalUsdCents,
} from "./link-metrics.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { column } from "./sql.ts";

export const PRODUCT_CACHED_VALUES = "product_cached_values";

const product = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" } as const;

// monthly_recurring_revenue and revenue_pending are decimal(10, 2): ActiveModel's Decimal type rounds a Float to the
// scale, keeps ten significant digits and rounds to the scale again; an Integer is kept whole.
const DECIMAL_PRECISION = 10;
const DECIMAL_SCALE = 2;

// Quoted into an INSERT as BigDecimal#to_s("F"), which always writes a fraction.
class RubyBigDecimal extends Prisma.Decimal {
  override toString(): string {
    const text = this.toFixed();
    return text.includes(".") ? text : `${text}.0`;
  }
}

function castDecimal(value: number | bigint): Prisma.Decimal {
  if (typeof value === "bigint") return new RubyBigDecimal(value.toString());
  const rounded = new RubyBigDecimal(rubyFloatRoundDigits(value, DECIMAL_SCALE).toString());
  return new RubyBigDecimal(
    rounded
      .toSignificantDigits(DECIMAL_PRECISION, Prisma.Decimal.ROUND_HALF_EVEN)
      .toDecimalPlaces(DECIMAL_SCALE, Prisma.Decimal.ROUND_HALF_UP),
  );
}

// ActiveModel::Type::Integer#cast of a Float: `to_i`.
const castInteger = (value: number): bigint => BigInt(Math.trunc(value));

export const ProductCachedValues = defineModel<ProductCachedValue>({
  rubyClass: "ProductCachedValue",
  prismaModel: "ProductCachedValue",
  delegate: (tx) => tx.productCachedValue as never,
  validations: [validatesAssociationPresence<ProductCachedValue>(product)],
  beforeCreate: [
    {
      name: "assign_cached_values",
      async run(record, ctx) {
        // validates_presence_of :product has just loaded it, so no statement is sent for it here.
        const link = associationCache(record).get(product.name)!.row as Link;
        const now = ctx.now ?? (() => new Date());
        // The metrics run in the order the attributes are written in.
        record.assign({
          successful_sales_count: await successfulSalesCount(link),
          remaining_for_sale_count: await remainingForSaleCount(link),
          monthly_recurring_revenue: castDecimal(await monthlyRecurringRevenue(link)),
          revenue_pending: castDecimal(await revenuePending(link, now)),
          total_usd_cents: castInteger(await totalUsdCents(link)),
        });
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
