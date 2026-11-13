// The parts of Purchase#json_data_for_mobile(include_sale_details: true) that come from a SKU, a shipment or an affiliate.
import { Prisma, type Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";

import { moneyFormatWithGemSymbol } from "./concerns/money-formatter.ts";
import { hasDirectAffiliateId } from "./json-direct-affiliate.ts";
import { calculatedTrackingUrl } from "./shipment-tracking.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const RUBY_REF = "Purchase#json_data_for_mobile";
const BASE_VARIANT_IS_DEFAULT_SKU = 1;
const blank = (value: string | null) => value === null || value.trim() === "";

export type SkuRow = {
  id: number;
  name: string | null;
  custom_sku: string | null;
  flags: number;
  link_id: number | null;
};

// Purchase#variant_details_hash and the sku_id keys of a purchase whose only variant is a SKU.
export async function skuDetails(sku: SkuRow) {
  // A default SKU prints like any other (recorded with no custom SKU); a custom SKU on one is not recorded.
  if ((sku.flags & BASE_VARIANT_IS_DEFAULT_SKU) !== 0 && !blank(sku.custom_sku))
    throw new NotPortedError("a default SKU with a custom SKU", RUBY_REF);
  // Link#sku_title joins `variant_categories_alive` (no ORDER BY) with " - "; InnoDB reads a `link_id` index in primary key order
  // (recorded for "Size - Color" created in that order).
  const categories = await selectRows<{ title: string | null }>(
    Prisma.sql`SELECT ${column("variant_categories", "title")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${sku.link_id} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC`,
  );
  const title = categories.length === 0 ? "Version" : categories.map((category) => category.title ?? "").join(" - ");
  const externalId = encrypt(BigInt(sku.id));
  return {
    variants: { [title ?? ""]: { is_sku: true, title, selected_variant: { id: externalId, name: sku.name } } },
    sku: { id: blank(sku.custom_sku) ? externalId : sku.custom_sku!, externalId },
  };
}

// `shipped`, `tracking_url` and `shipping_address`; `has_one :shipment` has no order, so a second row is Rails'.
export async function shipmentDetails(sale: Purchase) {
  const shipments = await selectRows<{
    shipped_at: Date | null;
    tracking_url: string | null;
    tracking_number: string | null;
    carrier: string | null;
  }>(
    Prisma.sql`SELECT ${column("shipments", "shipped_at")}, ${column("shipments", "tracking_url")}, ${column("shipments", "tracking_number")}, ${column("shipments", "carrier")} FROM ${table("shipments")} WHERE ${column("shipments", "purchase_id")} = ${sale.id} LIMIT 2`,
  );
  if (shipments.length === 0) return null;
  if (shipments.length > 1) throw new NotPortedError("a sale with several shipments", RUBY_REF);
  const [shipment] = shipments;
  return {
    shipped: shipment!.shipped_at !== null,
    tracking_url: calculatedTrackingUrl(shipment!),
    shipping_address: {
      full_name: sale.full_name,
      street_address: sale.street_address,
      city: sale.city,
      state: sale.state,
      zip_code: sale.zip_code,
      country: sale.country,
    },
  };
}

// The affiliate's form email and the credit it earned. A collaborator's credit is split with a direct affiliate: Rails'.
export async function affiliateDetails(sale: Purchase) {
  if (sale.affiliate_id === null) return null;
  if (hasDirectAffiliateId(sale.json_data))
    throw new NotPortedError("a collaborator sale with a direct affiliate", RUBY_REF);
  const affiliate = await db.affiliate.findUnique({ where: { id: Number(sale.affiliate_id) } });
  const user =
    affiliate?.affiliate_user_id == null
      ? null
      : await db.user.findUnique({ where: { id: BigInt(affiliate.affiliate_user_id) } });
  if (user === null) throw new NotPortedError("an affiliate whose user row is missing", RUBY_REF);
  // User#form_email
  const email = !blank(user.unconfirmed_email) ? user.unconfirmed_email : !blank(user.email) ? user.email : null;
  return { email, amount: moneyFormatWithGemSymbol(sale.affiliate_credit_cents ?? 0, "usd", { noCentsIfWhole: true }) };
}
