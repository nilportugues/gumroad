// Upsell as the dashboard and the public API read it: #as_json (OfferCode#configured_discount_for_display included) and the model
// service the dashboard's writes go through.
import { Prisma, type Link, type OfferCode, type Upsell, type UpsellVariant } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { deletable } from "./concerns/deletable.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import {
  belongsToRequired,
  loadBelongsTo,
  validatesAssociationPresence,
  type BelongsTo,
} from "./concerns/rails-validations.ts";
import { normalizeTiers, OfferCodeFlags, OfferCodeRecord, tiersOf } from "./offer-code.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const UPSELLS = "upsells";
const REPLACE_SELECTED_PRODUCTS = 1;
export const IS_CONTENT_UPSELL = 2;
// has_flags 1 => :replace_selected_products, 2 => :is_content_upsell, 4 => :offer_matching_version; the keys are bit positions, so the last is 8.
const OFFER_MATCHING_VERSION = 8;
const iso8601 = (time: Date | null) => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

type NamedRow = { id: bigint | number; name: string | null };

// OfferCode#configured_discount_for_display, which is OfferCode#discount until the code is tiered.
// With `anonymous`, OfferCode#discount_for_display(buyer: nil): an existing-customers code has nothing to show.
// With `buyerPresent`, OfferCode#evaluate_for_buyer, which is the same discount until the code looks at the buyer's purchases
// (an existing-customers or tiered code); those are handed back.
export async function discountForDisplay(
  upsell: Pick<Upsell, "offer_code_id">,
  anonymous = false,
  buyerPresent = false,
) {
  if (upsell.offer_code_id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${table("offer_codes")}.* FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${upsell.offer_code_id} LIMIT 1`,
  );
  if (row === undefined) return null;
  const code = castRow<OfferCode>("OfferCode", row);
  if (anonymous && code.existing_customers_only) return null;
  if (buyerPresent && (code.existing_customers_only || tiersOf(code.ownership_duration_tiers).length > 0))
    throw new NotPortedError("An offer code that depends on the buyer's purchases", "OfferCode#evaluate_for_buyer");
  const record = new OfferCodeRecord(code);
  const cents = code.amount_percentage == null;
  const json: Record<string, unknown> = {
    ...(cents ? { type: "fixed", cents: code.amount_cents } : { type: "percent", percents: code.amount_percentage }),
    product_ids: code.universal ? null : (await record.products()).map((product) => encrypt(product.id)),
    expires_at: iso8601(code.expires_at),
    minimum_quantity: code.minimum_quantity,
    duration_in_billing_cycles: code.duration_in_months,
    minimum_amount_cents: code.minimum_amount_cents,
  };
  if (code.universal) {
    const excluded = await record.excludedProducts();
    if (excluded.length > 0) json.excluded_product_ids = excluded.map((product) => encrypt(product.id));
  }
  if (await record.hasVariants()) {
    const grouped = new Map<string, string[]>();
    for (const variant of await record.variants()) {
      const key = encrypt((await variant.owningProductId()) as number);
      grouped.set(key, [...(grouped.get(key) ?? []), encrypt(variant.row.id)]);
    }
    json.option_ids_by_product = Object.fromEntries(grouped);
  }
  if (code.new_customers_only) json.new_customers_only = true;
  if (cents && OfferCodeFlags.isSet(code.flags, "once_per_cart")) {
    json.once_per_cart = true;
    json.once_per_cart_id = encrypt(code.id);
    json.once_per_cart_amount_cents = code.amount_cents;
    json.once_per_cart_has_usage_limit = code.max_purchase_count != null;
  }
  const tiers = tiersOf(code.ownership_duration_tiers);
  if (tiers.length === 0) return json;
  const percentages = normalizeTiers(tiers).map((tier) => tier.amount_percentage);
  return {
    ...json,
    type: "percent",
    percents: Math.max(...percentages),
    tiered: true,
    min_percents: Math.min(...percentages),
    max_percents: Math.max(...percentages),
  };
}

// Upsell#as_json
export async function upsellJson(upsell: Upsell) {
  const [product] = await selectRows<Link>(
    Prisma.sql`SELECT ${table("links")}.* FROM ${table("links")} WHERE ${column("links", "id")} = ${upsell.product_id} LIMIT 1`,
  );
  const [variant] =
    upsell.variant_id === null
      ? []
      : await selectRows<NamedRow>(
          Prisma.sql`SELECT id, name FROM ${table("base_variants")} WHERE id = ${upsell.variant_id} LIMIT 1`,
        );
  const selectedProducts = await selectRows<NamedRow>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} INNER JOIN upsells_selected_products ON links.id = upsells_selected_products.selected_product_id WHERE upsells_selected_products.upsell_id = ${upsell.id} ORDER BY upsells_selected_products.id`,
  );
  const upsellVariants = await selectRows<{
    id: bigint;
    selected_id: bigint;
    selected_name: string | null;
    offered_id: bigint;
    offered_name: string | null;
  }>(
    Prisma.sql`SELECT upsell_variants.id, selected.id AS selected_id, selected.name AS selected_name, offered.id AS offered_id, offered.name AS offered_name FROM upsell_variants LEFT JOIN base_variants selected ON selected.id = upsell_variants.selected_variant_id LEFT JOIN base_variants offered ON offered.id = upsell_variants.offered_variant_id WHERE upsell_variants.upsell_id = ${upsell.id} AND upsell_variants.deleted_at IS NULL ORDER BY upsell_variants.id`,
  );
  const flags = Number(upsell.flags);
  return {
    id: encrypt(upsell.id),
    name: upsell.name,
    cross_sell: upsell.cross_sell,
    replace_selected_products: (flags & REPLACE_SELECTED_PRODUCTS) !== 0,
    offer_matching_version: (flags & OFFER_MATCHING_VERSION) !== 0,
    universal: upsell.universal,
    text: upsell.text,
    description: upsell.description,
    paused: upsell.paused,
    product: {
      id: encrypt(product!.id),
      name: product!.name,
      currency_type: product!.price_currency_type?.toLowerCase() ?? "usd",
      variant: variant ? { id: encrypt(variant.id), name: variant.name } : null,
    },
    discount: await discountForDisplay(upsell),
    selected_products: selectedProducts.map((selected) => ({ id: encrypt(selected.id), name: selected.name })),
    upsell_variants: upsellVariants.map((entry) => ({
      id: encrypt(entry.id),
      selected_variant: { id: encrypt(entry.selected_id), name: entry.selected_name },
      offered_variant: { id: encrypt(entry.offered_id), name: entry.offered_name },
    })),
  };
}

const NATIVE_TYPE_CALL = "call";
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };
const paperTrail = hasPaperTrail<Upsell>("Upsell", { itemType: "Upsell" });

// `BaseVariant#link`: a SKU stores the product, a version or tier reaches it through its category.
async function owningProductId(variantId: bigint | number): Promise<bigint | number | null> {
  const [row] = await selectRows<{
    type: string | null;
    link_id: bigint | null;
    category_link_id: bigint | null;
    has_category: bigint | number;
  }>(
    Prisma.sql`SELECT ${column("base_variants", "type")}, ${column("base_variants", "link_id")}, ${column("variant_categories", "link_id")} AS category_link_id, ${column("variant_categories", "id")} IS NOT NULL AS has_category FROM ${table("base_variants")} LEFT JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("base_variants", "id")} = ${variantId} LIMIT 1`,
  );
  if (row === undefined) return null;
  if (row.type !== "Variant") return row.link_id;
  // Variant#link raises for a version whose category row is gone.
  if (Number(row.has_category) === 0) throw new NotPortedError("A version without its category", "BaseVariant#link");
  return row.category_link_id;
}

const sameId = (left: unknown, right: unknown) =>
  left != null && right != null && BigInt(left as bigint) === BigInt(right as bigint);

export const Upsells = defineModel<Upsell>({
  rubyClass: "Upsell",
  prismaModel: "Upsell",
  delegate: (tx) => tx.upsell as never,
  validations: [
    belongsToRequired<Upsell>(SELLER),
    belongsToRequired<Upsell>(PRODUCT),
    validatesAssociationPresence<Upsell>(SELLER),
    validatesAssociationPresence<Upsell>(PRODUCT),
    validatesPresenceOf<Upsell>(["name"], {
      unless: (record) => (Number(record.get("flags")) & IS_CONTENT_UPSELL) !== 0,
    }),
    {
      name: "selected_products_belong_to_seller",
      async run(record, { tx }) {
        if (!record.persisted) return;
        const rows = await tx.$queryRaw<{ user_id: bigint | null }[]>(
          Prisma.sql`SELECT ${column("links", "user_id")} FROM ${table("links")} INNER JOIN ${table("upsells_selected_products")} ON ${column("links", "id")} = ${column("upsells_selected_products", "selected_product_id")} WHERE ${column("upsells_selected_products", "upsell_id")} = ${record.get("id")}`,
        );
        if (rows.some((row) => !sameId(row.user_id, record.get("seller_id"))))
          record.errors.add("base", "invalid", { message: "All offered products must belong to the current seller." });
      },
    },
    {
      name: "product_belongs_to_seller",
      async run(record, ctx) {
        const product = await loadBelongsTo(record, PRODUCT, ctx);
        if (product === null || !sameId((product as { user_id: unknown }).user_id, record.get("seller_id"))) {
          record.errors.add("base", "invalid", { message: "The offered product must belong to the current seller." });
        }
      },
    },
    {
      name: "variant_belongs_to_product",
      async run(record) {
        const variantId = record.get("variant_id");
        if (variantId == null) return;
        if (!sameId(await owningProductId(variantId), record.get("product_id")))
          record.errors.add("base", "invalid", { message: "The offered variant must belong to the offered product." });
      },
    },
    {
      name: "offer_code_belongs_to_seller_and_product",
      async run(record, { tx }) {
        const offerCodeId = record.get("offer_code_id");
        if (offerCodeId == null) return;
        const [code] = await tx.$queryRaw<{ user_id: bigint | null; applies: bigint | number }[]>(
          Prisma.sql`SELECT ${column("offer_codes", "user_id")}, EXISTS (SELECT 1 FROM ${table("offer_codes_products")} WHERE ${column("offer_codes_products", "offer_code_id")} = ${column("offer_codes", "id")} AND ${column("offer_codes_products", "product_id")} = ${record.get("product_id")}) AS applies FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${offerCodeId} LIMIT 1`,
        );
        if (code === undefined) return;
        if (!sameId(code.user_id, record.get("seller_id")) || Number(code.applies) === 0) {
          record.errors.add("base", "invalid", {
            message: "The offer code must belong to the seller and the offered product.",
          });
        }
      },
    },
    {
      name: "has_one_upsell_variant_per_selected_variant",
      async run(record, { tx }) {
        if (!record.persisted) return;
        const [row] = await tx.$queryRaw<{ duplicated: bigint | number }[]>(
          Prisma.sql`SELECT COUNT(*) AS duplicated FROM (SELECT ${column("upsell_variants", "selected_variant_id")} FROM ${table("upsell_variants")} WHERE ${column("upsell_variants", "upsell_id")} = ${record.get("id")} AND ${column("upsell_variants", "deleted_at")} IS NULL GROUP BY ${column("upsell_variants", "selected_variant_id")} HAVING COUNT(*) > 1) AS duplicates`,
        );
        if (Number(row?.duplicated ?? 0) > 0)
          record.errors.add("base", "invalid", {
            message: "The upsell cannot have more than one upsell variant per selected variant.",
          });
      },
    },
    {
      name: "has_one_upsell_per_product",
      async run(record, { tx }) {
        if (record.get("cross_sell") || record.get("deleted_at") != null) return;
        const other = record.persisted
          ? Prisma.sql` AND ${column(UPSELLS, "id")} != ${record.get("id")}`
          : Prisma.empty;
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table(UPSELLS)} WHERE ${column(UPSELLS, "seller_id")} = ${record.get("seller_id")} AND ${column(UPSELLS, "cross_sell")} = FALSE AND ${column(UPSELLS, "deleted_at")} IS NULL AND ${column(UPSELLS, "product_id")} = ${record.get("product_id")}${other} LIMIT 1`,
        );
        if (rows.length > 0)
          record.errors.add("base", "invalid", { message: "You can only create one upsell per product." });
      },
    },
    {
      name: "product_is_not_call",
      async run(record, ctx) {
        const product = (await loadBelongsTo(record, PRODUCT, ctx)) as { native_type?: string | null } | null;
        if (product?.native_type === NATIVE_TYPE_CALL)
          record.errors.add("base", "invalid", { message: "Calls cannot be offered as upsells." });
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
});

export const UpsellDeletable = deletable(Upsells);

// Marking a variant deleted writes no PaperTrail version; its presence validations still run.
export const UpsellVariants = defineModel<UpsellVariant>({
  rubyClass: "UpsellVariant",
  prismaModel: "UpsellVariant",
  delegate: (tx) => tx.upsellVariant as never,
  validations: [
    belongsToRequired<UpsellVariant>({
      name: "upsell",
      foreignKey: "upsell_id",
      targetTable: UPSELLS,
      targetModel: "Upsell",
    }),
    belongsToRequired<UpsellVariant>({
      name: "selected_variant",
      foreignKey: "selected_variant_id",
      targetTable: "base_variants",
      targetModel: "BaseVariant",
    }),
    belongsToRequired<UpsellVariant>({
      name: "offered_variant",
      foreignKey: "offered_variant_id",
      targetTable: "base_variants",
      targetModel: "BaseVariant",
    }),
  ],
});

export const UpsellVariantDeletable = deletable(UpsellVariants);
