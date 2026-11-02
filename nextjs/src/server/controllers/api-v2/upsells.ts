// Api::V2::UpsellsController#index and #show (app/controllers/api/v2/upsells_controller.rb). Create, update and destroy run
// SaveUpsellService, whose validations and callbacks are not ported: they stay in Rails.
import { Prisma, type Link, type OfferCode, type Upsell } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { normalizeTiers, OfferCodeFlags, OfferCodeRecord, tiersOf } from "../../models/offer-code.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { errorWithObject, fromExternalId, PUBLIC_READ_SCOPES, registerApiV2, successWithObject } from "./base.ts";

const UPSELLS = "upsells";
// has_flags 1 => :replace_selected_products, 2 => :is_content_upsell, 4 => :offer_matching_version
const REPLACE_SELECTED_PRODUCTS = 1;
const IS_CONTENT_UPSELL = 2;
const OFFER_MATCHING_VERSION = 4;
const iso8601 = (time: Date | null) => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

type NamedRow = { id: bigint | number; name: string | null };

// OfferCode#configured_discount_for_display, which is OfferCode#discount until the code is tiered.
async function discountForDisplay(upsell: Upsell) {
  if (upsell.offer_code_id === null) return null;
  const [row] = await selectRows(Prisma.sql`SELECT ${table("offer_codes")}.* FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} = ${upsell.offer_code_id} LIMIT 1`);
  if (row === undefined) return null;
  const code = castRow<OfferCode>("OfferCode", row);
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
  return { ...json, type: "percent", percents: Math.max(...percentages), tiered: true, min_percents: Math.min(...percentages), max_percents: Math.max(...percentages) };
}

// Upsell#as_json
async function upsellJson(upsell: Upsell) {
  const [product] = await selectRows<Link>(Prisma.sql`SELECT ${table("links")}.* FROM ${table("links")} WHERE ${column("links", "id")} = ${upsell.product_id} LIMIT 1`);
  const [variant] = upsell.variant_id === null ? [] : await selectRows<NamedRow>(Prisma.sql`SELECT id, name FROM ${table("base_variants")} WHERE id = ${upsell.variant_id} LIMIT 1`);
  const selectedProducts = await selectRows<NamedRow>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} INNER JOIN upsells_selected_products ON links.id = upsells_selected_products.selected_product_id WHERE upsells_selected_products.upsell_id = ${upsell.id} ORDER BY upsells_selected_products.id`,
  );
  const upsellVariants = await selectRows<{ id: bigint; selected_id: bigint; selected_name: string | null; offered_id: bigint; offered_name: string | null }>(
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

// current_resource_owner.upsells.alive.not_is_content_upsell
const scope = (sellerId: bigint) => Prisma.sql`${column(UPSELLS, "seller_id")} = ${sellerId} AND ${column(UPSELLS, "deleted_at")} IS NULL AND (${column(UPSELLS, "flags")} & ${IS_CONTENT_UPSELL}) = 0`;

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/upsells",
    scopes: PUBLIC_READ_SCOPES,
    async run({ owner }) {
      const rows = await selectRows(Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${scope(owner.id)} ORDER BY ${column(UPSELLS, "id")}`);
      return successWithObject("upsells", await Promise.all(rows.map((row) => upsellJson(castRow<Upsell>("Upsell", row)))));
    },
  },
  {
    method: "GET",
    pattern: "/v2/upsells/:id",
    scopes: PUBLIC_READ_SCOPES,
    async run({ owner, routeParams }) {
      const id = fromExternalId(routeParams.id);
      const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${scope(owner.id)} AND ${column(UPSELLS, "id")} = ${id} LIMIT 1`);
      return row === undefined ? errorWithObject("upsell") : successWithObject("upsell", await upsellJson(castRow<Upsell>("Upsell", row)));
    },
  },
);
