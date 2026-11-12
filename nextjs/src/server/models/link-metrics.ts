// Port of app/models/link.rb (remaining_for_sale_count, variants_available?, sales_count_for_inventory) and of
// app/modules/product/stats.rb (Product::Stats, included in Link): the five metrics ProductCachedValue caches.
// Every statement and Elasticsearch request matches the Ruby ones one for one (golden:
// __fixtures__/link-metrics.golden.json, scripts/golden/link-metrics.rb).
//
// Handed back with NotPortedError, before the metric returns: a tier closed to new purchases on a tiered
// membership (BaseVariant#can_close_to_new_buyers? reads a Flipper feature) and a bundle variant that is
// not a Variant (a Sku counts its own stock).
import { Prisma, type BundleProduct, type Link } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { CHARGED_SALES_SEARCH_OPTIONS } from "../search/creator-analytics-sales.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { aggregationValue } from "../search/purchase-sales.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { BaseVariantFlags } from "./base-variant.ts";
import { castRow, column, findInBatches, selectRows, table } from "./sql.ts";
import { NoMethodError, NotPortedError } from "./user.ts";

// The two has_flags positions of link.rb these metrics read. link.ts imports product-cached-value.ts, which imports
// this file, so the full LinkFlags cannot be imported here.
const LinkFlags = defineFlags("links", { 19: "is_tiered_membership", 26: "is_bundle" }, { queryMode: "bit_operator" });

type Product = Pick<Link, "id" | "flags" | "max_purchase_count" | "duration_in_months">;
type VariantRow = {
  id: number;
  type: string | null;
  max_purchase_count: number | null;
  deleted_at: Date | null;
  flags: number;
};

// Purchase::NON_GIFT_SUCCESS_STATES
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];

// Purchase::ACTIVE_SALES_SEARCH_OPTIONS
const ACTIVE_SALES_SEARCH_OPTIONS = {
  state: NON_GIFT_SUCCESS_STATES,
  exclude_refunded_except_subscriptions: true,
  exclude_unreversed_chargedback: true,
  exclude_non_original_subscription_purchases: true,
  exclude_deactivated_subscriptions: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};

const SUBSCRIPTIONS_BATCH_SIZE = 1000;
const TIER_TITLE = "Tier";
const VARIANT_TYPE = "Variant";

// Link#successful_sales_count (Product::Stats): `self.class.successful_sales_count(products: self)`.
export async function successfulSalesCount(product: Product): Promise<number | null> {
  const result = await PurchaseSearchService.process({
    ...ACTIVE_SALES_SEARCH_OPTIONS,
    product: { id: product.id },
    size: 0,
    track_total_hits: true,
  });
  return result.total;
}

// Link#has_successful_sales? (Product::Stats): the same search with `track_total_hits: nil` merged over `true`, so the request
// carries no track_total_hits and the count stops at Elasticsearch's default cap, which is enough to tell zero from some.
export async function hasSuccessfulSales(product: Pick<Link, "id">): Promise<boolean> {
  const result = await PurchaseSearchService.process({
    ...ACTIVE_SALES_SEARCH_OPTIONS,
    product: { id: product.id },
    size: 0,
    track_total_hits: null,
  });
  // `nil > 0` raises in Ruby when the answer carries no total
  if (result.total === null) throw new NoMethodError("undefined method '>' for nil");
  return result.total > 0;
}

// Link#monthly_recurring_revenue (Product::Stats). A Float in Ruby.
export async function monthlyRecurringRevenue(product: Product): Promise<number> {
  const result = await PurchaseSearchService.process({
    product: { id: product.id },
    state: NON_GIFT_SUCCESS_STATES,
    exclude_non_original_subscription_purchases: true,
    exclude_deactivated_subscriptions: true,
    exclude_cancelled_or_pending_cancellation_subscriptions: true,
    exclude_bundle_product_purchases: true,
    aggs: { mrr_total: { sum: { field: "monthly_recurring_revenue" } } },
    size: 0,
  });
  return aggregationValue(aggregations(result.response)["mrr_total"]?.value, "mrr_total");
}

// Link#total_usd_cents (Product::Stats), with no extra search options. A Float in Ruby.
export async function totalUsdCents(product: Product): Promise<number> {
  const result = await PurchaseSearchService.process({
    ...CHARGED_SALES_SEARCH_OPTIONS,
    product: { id: product.id },
    size: 0,
    aggs: {
      price_cents_total: { sum: { field: "price_cents" } },
      amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
    },
  });
  const sums = aggregations(result.response);
  return (
    aggregationValue(sums["price_cents_total"]?.value, "price_cents_total") -
    aggregationValue(sums["amount_refunded_cents_total"]?.value, "amount_refunded_cents_total")
  );
}

// A response without aggregations reads as an empty Hashie::Mash, whose members are nil.
function aggregations(response: {
  aggregations?: Record<string, unknown>;
}): Record<string, { value?: number | null } | undefined> {
  return (response.aggregations ?? {}) as Record<string, { value?: number | null } | undefined>;
}

// Link#revenue_pending (Product::Stats): `duration_in_months? ? pending_balance : 0`. An Integer in Ruby.
export async function revenuePending(product: Product, now: () => Date): Promise<bigint> {
  // `duration_in_months?` on an Integer column is `!zero?` of a non-nil value.
  return product.duration_in_months !== null && product.duration_in_months !== 0 ? pendingBalance(product, now) : 0n;
}

// Link#pending_balance (Product::Stats): the charges each active subscription still owes at its first price.
async function pendingBalance(product: Product, now: () => Date): Promise<bigint> {
  let total = 0n;
  // Subscription.active: not a test subscription, not failed or ended, not cancelled before now.
  const active = Prisma.sql`${column("subscriptions", "link_id")} = ${product.id} AND (subscriptions.flags & ${"1"} = 0 and failed_at is null and ended_at is null and (cancelled_at is null or cancelled_at > ${now()}))`;
  await findInBatches<{ id: bigint; charge_occurrence_count: number | null }>(
    "subscriptions",
    active,
    SUBSCRIPTIONS_BATCH_SIZE,
    async (subscriptions) => {
      for (const subscription of subscriptions) {
        const remaining = await remainingChargesCount(subscription);
        const [original] = await selectRows<{ price_cents: number | null }>(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id} AND (${PurchaseFlags.condition("is_original_subscription_purchase")}) AND (${PurchaseFlags.condition("is_archived_original_subscription_purchase", false)}) LIMIT 1`,
        );
        if (original === undefined) throw new NoMethodError("undefined method 'price_cents' for nil");
        if (original.price_cents === null) throw new TypeError("nil can't be coerced into Integer");
        total += remaining * BigInt(original.price_cents);
      }
    },
  );
  return total;
}

// Subscription#remaining_charges_count. Test subscriptions never reach it: Subscription.active leaves them out.
async function remainingChargesCount(subscription: {
  id: bigint;
  charge_occurrence_count: number | null;
}): Promise<bigint> {
  if (subscription.charge_occurrence_count === null) return 0n;
  const [row] = await selectRows<Record<string, bigint | number>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id} AND ${column("purchases", "purchase_state")} = ${"successful"}`,
  );
  return BigInt(subscription.charge_occurrence_count) - BigInt(Object.values(row!)[0]!);
}

// Link#remaining_for_sale_count. nil when nothing limits the stock.
export async function remainingForSaleCount(product: Product): Promise<number | null> {
  if (!(await variantsAvailable(product))) return 0;

  const { size, first } = await tiers(product);
  if (size === 1) {
    if (first === null) throw new NoMethodError("undefined method 'quantity_left' for nil");
    return quantityLeft(first);
  }

  let minimumBundleProductQuantityLeft: number | null = null;
  if (LinkFlags.isSet(product.flags, "is_bundle")) {
    const left: number[] = [];
    for (const bundleProduct of await aliveBundleProducts(product)) {
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${bundleProduct.product_id} LIMIT 1`,
      );
      if (row === undefined) throw new NoMethodError("undefined method 'remaining_for_sale_count' for nil");
      const productLeft = await remainingForSaleCount(castRow<Link>("Link", row));
      if (productLeft !== null) left.push(productLeft);
      const variantLeft = await bundleVariantQuantityLeft(bundleProduct);
      if (variantLeft !== null) left.push(variantLeft);
    }
    minimumBundleProductQuantityLeft = left.length === 0 ? null : Math.min(...left);
  }

  const productQuantityLeft =
    product.max_purchase_count === null ? null : product.max_purchase_count - (await salesCountForInventory(product));
  const candidates = [productQuantityLeft, minimumBundleProductQuantityLeft].filter(
    (count): count is number => count !== null,
  );
  if (candidates.length === 0) return null;
  return Math.max(Math.min(...candidates), 0);
}

// Link#sales_count_for_inventory, `.to_i`: read fresh from the row.
async function salesCountForInventory(product: Product): Promise<number> {
  const [row] = await selectRows<{ sales_count_for_inventory_cache: number }>(
    Prisma.sql`SELECT ${column("links", "sales_count_for_inventory_cache")} FROM ${table("links")} WHERE ${column("links", "id")} = ${product.id} LIMIT 1`,
  );
  return row === undefined ? 0 : Number(row.sales_count_for_inventory_cache);
}

// BaseVariant#sales_count_for_inventory, `.to_i`, for a Variant.
async function variantSalesCountForInventory(variant: VariantRow): Promise<number> {
  if (variant.type !== VARIANT_TYPE)
    throw new NotPortedError(
      "the stock of a variant that is not a Variant",
      "base_variant.rb sales_count_for_inventory",
    );
  const [row] = await selectRows<{ sales_count_for_inventory_cache: number }>(
    Prisma.sql`SELECT ${column("base_variants", "sales_count_for_inventory_cache")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = ${VARIANT_TYPE} AND ${column("base_variants", "id")} = ${variant.id} LIMIT 1`,
  );
  return row === undefined ? 0 : Number(row.sales_count_for_inventory_cache);
}

// BaseVariant#quantity_left
async function quantityLeft(variant: VariantRow): Promise<number | null> {
  if (variant.max_purchase_count === null) return null;
  return Math.max(variant.max_purchase_count - (await variantSalesCountForInventory(variant)), 0);
}

// BaseVariant#available?, for a variant of a product that is or is not a tiered membership.
async function variantAvailable(variant: VariantRow, product: Product): Promise<boolean> {
  if (variant.deleted_at !== null) return false;
  // closed_to_new_buyers? is `closed_to_new_purchases? && can_close_to_new_buyers?`, and only a tiered membership reaches the Flipper feature.
  if (BaseVariantFlags.isSet(variant.flags, "closed_to_new_purchases")) {
    if (LinkFlags.isSet(product.flags, "is_tiered_membership")) {
      throw new NotPortedError(
        "Feature.active?(close_membership_tier_to_new_buyers)",
        "base_variant.rb can_close_to_new_buyers?",
      );
    }
  }
  if (variant.max_purchase_count === null) return true;
  return (await quantityLeft(variant))! > 0;
}

// Link#variants_available?
async function variantsAvailable(product: Product): Promise<boolean> {
  const aliveCategories = Prisma.sql`${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL`;
  const exists = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("variant_categories")} WHERE ${aliveCategories} LIMIT 1`,
  );
  if (exists.length === 0) return true;

  const categories = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${aliveCategories}`,
  );
  for (const category of categories) {
    // VariantCategory#available?
    const aliveVariants = Prisma.sql`${column("base_variants", "type")} = ${VARIANT_TYPE} AND ${column("base_variants", "variant_category_id")} = ${category.id} AND ${column("base_variants", "deleted_at")} IS NULL`;
    const any = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} WHERE ${aliveVariants} LIMIT 1`,
    );
    if (any.length === 0) return true;
    const variants = await selectRows<VariantRow>(
      Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${aliveVariants}`,
    );
    for (const variant of variants) if (await variantAvailable(variant, product)) return true;
  }
  return false;
}

// Link#tiers (`has_many :tiers, through: :tier_categories`): `tiers.size`, then `tiers.first` when there is one.
async function tiers(product: Product): Promise<{ size: number; first: VariantRow | null }> {
  const tierRows = Prisma.sql`FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("base_variants", "type")} = ${VARIANT_TYPE} AND ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = ${TIER_TITLE} AND ${column("base_variants", "deleted_at")} IS NULL`;
  const [count] = await selectRows<Record<string, bigint | number>>(Prisma.sql`SELECT COUNT(*) ${tierRows}`);
  const size = Number(Object.values(count!)[0]);
  if (size !== 1) return { size, first: null };
  const [first] = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} ${tierRows} ORDER BY ${column("base_variants", "id")} ASC LIMIT 1`,
  );
  return { size, first: first ?? null };
}

// Link#bundle_products.alive
function aliveBundleProducts(product: Product): Promise<BundleProduct[]> {
  return selectRows<BundleProduct>(
    Prisma.sql`SELECT ${Prisma.raw("`bundle_products`.*")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${product.id} AND ${column("bundle_products", "deleted_at")} IS NULL`,
  );
}

// `bundle_product.variant&.quantity_left`: the variant is a belongs_to on BaseVariant.
async function bundleVariantQuantityLeft(bundleProduct: BundleProduct): Promise<number | null> {
  if (bundleProduct.variant_id === null) return null;
  const [variant] = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${bundleProduct.variant_id} LIMIT 1`,
  );
  return variant === undefined ? null : quantityLeft(variant);
}
