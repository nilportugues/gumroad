// The records the v2 product-resource controllers read and how the models serialize them for the API (`as_json`).
import type { BaseVariant, CustomField, Link, ProductBuild, VariantCategory } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { LinkFlags } from "../../models/link.ts";
import { moneyFormatterFormat } from "../../models/concerns/money-formatter.ts";

export const externalId = (id: number | bigint): string => encrypt(id);

// ActiveSupport::JSON::Encoding.time_precision = 0, in UTC (config.time_zone is unset).
export const timeJson = (time: Date | null): string | null => (time === null ? null : time.toISOString().replace(/\.\d{3}Z$/u, "Z"));

export const linkFlag = (link: Link, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(link.flags, name);

// BasePrice::Recurrence.all
export const RECURRENCES = ["monthly", "quarterly", "biannually", "yearly", "every_two_years"] as const;

// BaseVariant flags (has_flags 1 => :is_default_sku, 2 => :apply_price_changes_to_existing_memberships, 3 => :closed_to_new_purchases)
export const IS_DEFAULT_SKU = 1;
// BasePrice flag 1: is_rental
const IS_RENTAL = 1;

export const aliveVariantCategories = (link: Link) => db.variantCategory.findMany({ where: { link_id: Number(link.id), deleted_at: null }, orderBy: { id: "asc" } });

export const variantCategoryJson = (category: VariantCategory) => ({ id: externalId(category.id), title: category.title });

// The product's `alive_variants`: the alive versions of its alive categories, category by category.
export async function aliveVariants(link: Link): Promise<BaseVariant[]> {
  const categories = await aliveVariantCategories(link);
  if (categories.length === 0) return [];
  return db.baseVariant.findMany({ where: { type: "Variant", variant_category_id: { in: categories.map((category) => category.id) }, deleted_at: null }, orderBy: [{ variant_category_id: "asc" }, { id: "asc" }] });
}

// BaseVariant#as_json without `for_views`, Sku's custom_sku included.
export function baseVariantJson(variant: BaseVariant): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: externalId(variant.id),
    max_purchase_count: variant.max_purchase_count,
    name: variant.name,
    description: variant.description,
    price_difference_cents: variant.price_difference_cents,
  };
  if (variant.type === "Sku" && variant.custom_sku) json.custom_sku = variant.custom_sku;
  return json;
}

// Variant#as_json: the price fields join a version that has prices, or any tier.
export async function variantJson(variant: BaseVariant, link: Link): Promise<Record<string, unknown>> {
  const json = baseVariantJson(variant);
  const prices = await db.basePrice.findMany({ where: { variant_id: variant.id, deleted_at: null }, orderBy: { id: "asc" } });
  if (prices.length === 0 && !linkFlag(link, "is_tiered_membership")) return json;
  json.is_customizable_price = variant.customizable_price === true;
  json.recurrence_price_values = await recurrencePriceValuesForEdit(variant, link, prices);
  return json;
}

const displayPrice = (cents: number, currency: string) => moneyFormatterFormat(cents, currency, { noCentsIfWhole: true, symbol: false });

// Variant#recurrence_price_values(for_edit: true)
async function recurrencePriceValuesForEdit(variant: BaseVariant, link: Link, prices: { recurrence: string | null; price_cents: number; suggested_price_cents: number | null; flags: bigint | number }[]) {
  const productPrices = variant.deleted_at === null ? await db.basePrice.findMany({ where: { link_id: Number(link.id), deleted_at: null } }) : [];
  const buy = (price: { flags: bigint | number }) => (BigInt(price.flags) & BigInt(IS_RENTAL)) === 0n;
  const values: Record<string, unknown> = {};
  for (const recurrence of RECURRENCES) {
    const enabled = productPrices.some((price) => buy(price) && price.recurrence === recurrence);
    const price = enabled ? prices.find((candidate) => buy(candidate) && candidate.recurrence === recurrence) : undefined;
    if (!price) {
      values[recurrence] = { enabled: false };
      continue;
    }
    const entry: Record<string, unknown> = {
      enabled: true,
      price_cents: price.price_cents,
      suggested_price_cents: price.suggested_price_cents,
      price: displayPrice(price.price_cents, link.price_currency_type ?? "usd"),
    };
    if (price.suggested_price_cents !== null) entry.suggested_price = displayPrice(price.suggested_price_cents, link.price_currency_type ?? "usd");
    values[recurrence] = entry;
  }
  return values;
}

// CustomField#as_json
export async function customFieldJson(field: CustomField): Promise<Record<string, unknown>> {
  const joins = await db.customFieldsProduct.findMany({ where: { custom_field_id: field.id }, orderBy: { id: "asc" } });
  const products = joins.length === 0 ? [] : await db.link.findMany({ where: { id: { in: joins.map((join) => join.product_id) } } });
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    id: externalId(field.id),
    type: field.field_type,
    name: field.name,
    required: field.required,
    global: field.global,
    collect_per_product: (BigInt(field.flags) & 2n) === 2n,
    products: joins.flatMap((join) => (byId.has(join.product_id) ? [externalId(join.product_id)] : [])),
  };
}

// ProductBuild#as_json
export const productBuildJson = (build: ProductBuild) => ({
  id: build.public_id,
  number: build.number,
  status: build.status,
  byte_size: Number(build.byte_size),
  created_at: timeJson(build.created_at),
  promoted_at: timeJson(build.promoted_at),
});
