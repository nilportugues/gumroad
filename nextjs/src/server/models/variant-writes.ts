// Write side of app/models/variant.rb and base_variant.rb, for what Api::V2::VariantsController#create, #update and #destroy save: a version
// of a plain product, meaning no tiers, no call or coffee type, no price of its own on the version (`assertPlainVariantProduct`,
// `assertPlainVariant`). Both run before the first statement, so a version outside them goes to Rails with nothing written; the validations
// and callbacks they leave out are the ones that cannot fire for a plain version (each is named below where its Ruby declaration sits).
//
// Rails-recorded proof: spec/requests/api/v2/variants_writes_parity_spec.rb, replayed by parity/__tests__/api-v2-ws17c.replay.test.ts
// (row diffs, jobs, response). The order of the statements is pinned by variant-writes.test.ts against the fixtures' `timeline`.
import { Prisma, type BaseVariant, type Link } from "@prisma/client";

import { NotPortedError } from "../page-props/not-ported.ts";

import { BaseVariantFlags } from "./base-variant.ts";
import {
  enqueueLinkIndexUpdate,
  findLinkBang,
  invalidateProductCache,
  Links,
  defaultPriceCents,
  LinkFlags,
} from "./link.ts";
import { MAX_PURCHASE_COUNT_RANGE } from "./offer-code-writes.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { column, execute, selectRows, table } from "./sql.ts";

const VARIANT = "Variant";
const NATIVE_TYPES_WITH_OWN_RULES = ["coffee", "call"];
// BaseVariant::MINIMUM_DAYS_TIL_EXISTING_MEMBERSHIP_PRICE_CHANGE is for memberships, which never get here.
const notPorted = (what: string): never => {
  throw new NotPortedError(what);
};

export type VariantWrite = ModelRecord<BaseVariant>;

// Products whose versions carry rules or writes the port does not follow: a tier (prices, `set_customizable_price`), the call and coffee
// native types (their own validations), and a free product (`Link#set_customizable_price` writes the product's column after every save).
export async function assertPlainVariantProduct(product: Link): Promise<void> {
  if (LinkFlags.isSet(product.flags, "is_tiered_membership")) notPorted("a version of a tiered membership");
  if (product.native_type !== null && NATIVE_TYPES_WITH_OWN_RULES.includes(product.native_type))
    notPorted(`a version of a ${product.native_type} product`);
  if ((await defaultPriceCents(Links.load(product))) === 0) notPorted("a version of a free product");
}

// What #destroy follows: a plain product's version as above, or a tier, whose only extra write is `set_customizable_price` (below).
// A tier's prices are not read for the response (a deletion answers with no version) and are not validated (`update_attribute`).
export async function assertDeletableVariantProduct(product: Link): Promise<void> {
  if (!LinkFlags.isSet(product.flags, "is_tiered_membership")) return assertPlainVariantProduct(product);
  if (product.native_type !== null && NATIVE_TYPES_WITH_OWN_RULES.includes(product.native_type))
    notPorted(`a tier of a ${product.native_type} product`);
}

// A saved version outside the plain shape: one that applies price changes to memberships, or has prices of its own (they are validated
// against the currency's range and printed by as_json).
export async function assertPlainVariant(row: BaseVariant, options: { pricesAllowed?: boolean } = {}): Promise<void> {
  if (BaseVariantFlags.isSet(row.flags, "apply_price_changes_to_existing_memberships"))
    notPorted("a version that applies price changes to existing memberships");
  if (row.subscription_price_change_message !== null) notPorted("a version with a price change message");
  if (options.pricesAllowed) return;
  const [prices] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${row.id}) AS found`,
  );
  if (Number(prices?.found ?? 0) > 0) notPorted("a version with prices of its own");
}

const aliveVariantsOfCategory = (categoryId: number) =>
  Prisma.sql`FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = ${VARIANT} AND ${column("base_variants", "variant_category_id")} = ${categoryId} AND ${column("base_variants", "deleted_at")} IS NULL`;

// Variant#set_position: after the last live version of the category (`in_order` is position, then created_at).
async function setPosition(record: VariantWrite): Promise<void> {
  if (record.get("position_in_category") != null) return;
  const categoryId = record.get("variant_category_id");
  if (categoryId == null) return;
  const [previous] = await selectRows<{ position_in_category: number | null }>(
    Prisma.sql`SELECT ${column("base_variants", "position_in_category")} ${aliveVariantsOfCategory(categoryId)} ORDER BY ${column("base_variants", "position_in_category")} DESC, ${column("base_variants", "created_at")} DESC LIMIT 1`,
  );
  if (previous === undefined) return void record.set("position_in_category", 0);
  if (previous.position_in_category != null)
    return void record.set("position_in_category", previous.position_in_category + 1);
  const [count] = await selectRows<{ total: number | bigint }>(
    Prisma.sql`SELECT COUNT(*) AS total ${aliveVariantsOfCategory(categoryId)}`,
  );
  record.set("position_in_category", Number(count?.total ?? 0));
}

// BaseVariant#max_purchase_count_is_greater_than_or_equal_to_inventory_sold: the cached count of a saved version is read from the row.
async function maxPurchaseCountCoversSales(record: VariantWrite): Promise<void> {
  if (!record.attributeChanged("max_purchase_count")) return;
  const max = record.get("max_purchase_count");
  if (max == null) return;
  let sold = Number(record.get("sales_count_for_inventory_cache") ?? 0);
  if (record.persisted) {
    const [row] = await selectRows<{ sales: number | null }>(
      Prisma.sql`SELECT ${column("base_variants", "sales_count_for_inventory_cache")} AS sales FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${record.get("id")} LIMIT 1`,
    );
    sold = Number(row?.sales ?? 0);
  }
  if (max >= sold) return;
  record.errors.add(
    "base",
    `You have chosen an amount lower than what you have already sold. Please enter an amount greater than ${sold}.`,
  );
}

// BaseVariant#price_difference_cents_validation; the coffee rule below it needs a coffee product, which assertPlainVariantProduct refuses.
function priceDifferenceIsNotNegative(record: VariantWrite): void {
  const price = record.get("price_difference_cents");
  if (price != null && price < 0)
    record.errors.add("base", "Please enter a price that is equal to or greater than the price of the product.");
}

// The link of a version: its category's product.
async function productIdOf(record: VariantWrite): Promise<bigint | null> {
  const categoryId = record.get("variant_category_id");
  if (categoryId == null) return null;
  const [row] = await selectRows<{ link_id: number | null }>(
    Prisma.sql`SELECT ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "id")} = ${categoryId} LIMIT 1`,
  );
  return row?.link_id == null ? null : BigInt(row.link_id);
}

// Variant::Prices#set_customizable_price (after_save, update_column so updated_at stays): a tier whose live prices are all free is
// pay what you want. A tier with no live price, or any paid one, keeps its flag.
async function setCustomizablePrice(record: VariantWrite): Promise<void> {
  const productId = await productIdOf(record);
  if (productId === null || !LinkFlags.isSet((await findLinkBang(productId)).get("flags"), "is_tiered_membership"))
    return;
  const [prices] = await selectRows<{ total: number | bigint; paid: number | bigint | null }>(
    Prisma.sql`SELECT COUNT(*) AS total, SUM(${column("prices", "price_cents")} > 0) AS paid FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${record.get("id")} AND ${column("prices", "deleted_at")} IS NULL`,
  );
  if (Number(prices?.total ?? 0) === 0 || Number(prices?.paid ?? 0) > 0) return;
  await execute(
    Prisma.sql`UPDATE ${table("base_variants")} SET ${column("base_variants", "customizable_price")} = TRUE WHERE ${column("base_variants", "id")} = ${record.get("id")}`,
  );
}

export const Variants = defineModel<BaseVariant>({
  rubyClass: VARIANT,
  prismaModel: "BaseVariant",
  delegate: (tx) => tx.baseVariant as never,
  beforeValidation: [
    {
      // MaxPurchaseCount#constrain_max_purchase_count_within_range. Its numericality validation, declared with it, cannot fail afterwards.
      name: "constrain_max_purchase_count_within_range",
      run(record) {
        const max = record.get("max_purchase_count");
        if (max != null)
          record.set(
            "max_purchase_count",
            Math.min(Math.max(max, MAX_PURCHASE_COUNT_RANGE.min), MAX_PURCHASE_COUNT_RANGE.max),
          );
      },
    },
    // strip_subscription_price_change_message runs only for a version that has a message, and assertPlainVariant refuses those.
  ],
  validations: [
    validatesPresenceOf<BaseVariant>(["name"]),
    { name: "max_purchase_count_is_greater_than_or_equal_to_inventory_sold", run: maxPurchaseCountCoversSales },
    { name: "price_difference_cents_validation", run: priceDifferenceIsNotNegative },
    // apply_price_changes_to_existing_memberships_settings needs the flag, which assertPlainVariant keeps off.
    {
      name: "validates_presence_of :variant_category",
      run(record) {
        if (record.get("variant_category_id") == null) record.errors.add("variant_category", "blank");
      },
    },
    // price_must_be_within_range validates the version's own prices, and duration_in_minutes belongs to call products.
  ],
  beforeCreate: [{ name: "set_position", run: setPosition }],
  // sync_product_customizable_price writes only for a free product that is not a tier, which assertPlainVariantProduct refuses.
  afterSave: [{ name: "set_customizable_price", run: setCustomizablePrice }],
  afterCommit: [
    // Declared in this order; Rails runs them in reverse (run_after_transaction_callbacks_in_order_defined = false).
    {
      // TouchesProductForPriceCache
      name: "touch_product_for_price_cache",
      async run(record, ctx) {
        const changed = Object.keys(record.savedChanges);
        if (changed.length === 0 || (changed.length === 1 && changed[0] === "updated_at")) return;
        const productId = await productIdOf(record);
        if (productId === null) return;
        await Links.touch(await findLinkBang(productId), { now: ctx.now });
      },
    },
    {
      name: "invalidate_product_cache",
      async run(record, ctx) {
        if (Object.keys(record.savedChanges).length === 0) return;
        const productId = await productIdOf(record);
        if (productId !== null) await invalidateProductCache(productId, ctx.now);
      },
    },
    {
      name: "update_product_search_index",
      async run(record, ctx) {
        // saved_change_to_closed_to_new_purchases? is bit 3 of flags, which the API never writes.
        if (!record.savedChangeTo("price_difference_cents")) return;
        const productId = await productIdOf(record);
        if (productId !== null) await enqueueLinkIndexUpdate(productId, ["available_price_cents"], ctx.now);
      },
    },
  ],
});

export const buildVariant = (attributes: Partial<BaseVariant>) => Variants.build({ ...attributes, type: VARIANT });
export const loadVariantRecord = (row: BaseVariant) => Variants.load(row);
