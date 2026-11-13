// Port of Exports::PurchaseExportService#purchases_data and #purchase_data (app/services/exports/purchase_export_service.rb) for the sales
// the port can prove: a sale of one variant or SKU at most, whose columns come from the purchase row, its buyer, its offer code, its
// refunds, its custom fields, its gift, pre-order, tip, review, license, UTM link, affiliate, buyer-currency charge, order's cart and
// PayPal or Connect charge. A sale that needs anything else (a gift's receiver, subscriptions, several variants, a GeoIP lookup or
// a row Rails would raise on) throws HandBackToRails: the export is a read, so Rails serves the whole request and nothing is half done.
import { Prisma, type Purchase } from "@prisma/client";

import type { CsvCell } from "../../lib/csv-safe.ts";
import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
  GST_APPLICABLE_COUNTRY_CODES,
  NORWAY_VAT_APPLICABLE_COUNTRY_CODES,
  taxNameFor,
} from "../mail/mailers/receipt-tax.ts";
import { BaseVariantFlags } from "../models/base-variant.ts";
import { chargeSubunitToUnit, UnknownCurrency } from "../models/concerns/money-formatter.ts";
import { rubyInspect } from "../models/concerns/ruby-values.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { type PurchaseDataRow, paymentTypeLabel, zipCodeForExport } from "./purchase-export.ts";
import { pseudoTransliterate } from "./transliterate.ts";

const CENTS_PER_DOLLAR = 100;
// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];
// CustomField::BOOLEAN_TYPES
const BOOLEAN_FIELD_TYPES = ["terms", "checkbox"];
// String#inspect prints a non-ASCII letter, mark, number, punctuation or symbol as it is. The recordings prove no other category
// (control, format, separator, private use, unassigned), so a custom field holding one stays with Rails.
const PRINTED_RAW = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const inspectsRaw = (value: string): boolean =>
  [...value].every((char) => char.codePointAt(0)! < 0x80 || PRINTED_RAW.test(char));

// convert_cents_to_dollars: (cents.to_f / 100).round(2)
const dollars = (cents: number | null | undefined): RubyFloat =>
  new RubyFloat(rubyRoundHalfUp((cents ?? 0) / CENTS_PER_DOLLAR));

const flagSet = (purchase: Purchase, name: Parameters<typeof PurchaseFlags.isSet>[1]): boolean =>
  PurchaseFlags.isSet(purchase.flags, name);

type CustomFieldRow = { purchase_id: bigint; name: string | null; value: string | null; field_type: string | null };
type LicenseRow = { purchase_id: bigint; serial: string | null; uses: number | null; disabled_at: Date | null };
type UtmRow = {
  purchase_id: bigint;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
};
type GiftRow = { gifter_purchase_id: bigint | null; giftee_purchase_id: bigint | null; giftee_email: string | null };
type RefundRow = {
  purchase_id: bigint;
  amount_cents: number | null;
  json_data: string | null;
};
type PresentmentRow = { purchase_id: bigint; presentment_currency: string | null; presentment_total_cents: bigint };
// The buyer-currency columns of a sale charged in the buyer's currency: the charged total and what its refunds returned.
type Presentment = { currency: string; totalCents: number; refundedCents: number; refundsIncomplete: boolean };
// The one BaseVariant (a Variant or a Sku) a purchase holds in `variant_attributes`.
type VariantRow = {
  purchase_id: bigint;
  id: bigint;
  type: string | null;
  name: string | null;
  price_difference_cents: number | null;
  custom_sku: string | null;
  flags: bigint;
};

// ProductsHelper#variants_displayable of the variants that are not the default SKU.
function variantsDisplayable(variant: VariantRow | undefined): string {
  if (variant === undefined || BaseVariantFlags.isSet(variant.flags, "is_default_sku")) return "";
  return variant.name === "Untitled" ? "" : `(${variant.name ?? ""})`;
}

const pad = (value: number) => String(value).padStart(2, "0");
const dateOf = (value: Date) => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
// Time#to_s of a UTC time on a server whose zone is UTC.
const timeOf = (value: Date) =>
  `${dateOf(value)} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} +0000`;

// Hash#inspect of {name => value}, for the "Custom Fields" cell.
function hashInspect(entries: Map<string, string | boolean | null>): string {
  if (entries.size === 0) return "{}";
  const parts = [...entries].map(
    ([name, value]) =>
      `${rubyInspect(name)} => ${typeof value === "boolean" ? String(value) : value === null ? "nil" : rubyInspect(value)}`,
  );
  return `{${parts.join(", ")}}`;
}

// Purchase#sent_abandoned_cart_email?: an email of the seller's abandoned cart workflow went to the cart of the sale's order.
async function salesWithAbandonedCartEmail(
  purchases: readonly Purchase[],
  linkById: ReadonlyMap<string, { user_id: bigint | null }>,
): Promise<Set<string>> {
  const purchaseIds = purchases.map((purchase) => purchase.id);
  const orderPurchases = await selectRows<{ purchase_id: bigint; order_id: bigint | null }>(
    Prisma.sql`SELECT ${column("order_purchases", "purchase_id")}, ${column("order_purchases", "order_id")} FROM ${table("order_purchases")} WHERE ${column("order_purchases", "purchase_id")} IN (${Prisma.join(purchaseIds)}) ORDER BY ${column("order_purchases", "id")}`,
  );
  const orderOf = new Map<string, bigint>();
  let ambiguous = false;
  for (const row of orderPurchases) {
    // has_one :order_purchase and has_one :cart have no order of their own.
    if (orderOf.has(String(row.purchase_id))) ambiguous = true;
    if (row.order_id !== null) orderOf.set(String(row.purchase_id), row.order_id);
  }
  if (orderOf.size === 0) return new Set();
  const orderIds = [...new Set(orderOf.values())];
  const orders = new Set(
    (
      await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("orders", "id")} FROM ${table("orders")} WHERE ${column("orders", "id")} IN (${Prisma.join(orderIds)})`,
      )
    ).map((row) => String(row.id)),
  );
  const cartOf = new Map<string, bigint>();
  for (const cart of await selectRows<{ id: bigint; order_id: bigint }>(
    Prisma.sql`SELECT ${column("carts", "id")}, ${column("carts", "order_id")} FROM ${table("carts")} WHERE ${column("carts", "order_id")} IN (${Prisma.join(orderIds)})`,
  )) {
    if (cartOf.has(String(cart.order_id))) ambiguous = true;
    cartOf.set(String(cart.order_id), cart.id);
  }
  if (ambiguous) throw new HandBackToRails("a sale in several orders or an order with several carts");
  const cartIds = [...cartOf.values()];
  const emailSellers = new Map<string, (bigint | null)[]>();
  if (cartIds.length > 0)
    for (const email of await selectRows<{
      cart_id: bigint;
      installment_id: bigint;
      installment_exists: bigint | null;
      seller_id: bigint | null;
    }>(
      Prisma.sql`SELECT ${column("sent_abandoned_cart_emails", "cart_id")}, ${column("sent_abandoned_cart_emails", "installment_id")}, ${column("installments", "id")} AS installment_exists, ${column("installments", "seller_id")} FROM ${table("sent_abandoned_cart_emails")} LEFT JOIN ${table("installments")} ON ${column("installments", "id")} = ${column("sent_abandoned_cart_emails", "installment_id")} WHERE ${column("sent_abandoned_cart_emails", "cart_id")} IN (${Prisma.join(cartIds)})`,
    )) {
      // `_1.installment.seller_id` raises for an email whose installment is gone.
      if (email.installment_exists === null)
        throw new HandBackToRails("an abandoned cart email without its installment");
      emailSellers.set(String(email.cart_id), [...(emailSellers.get(String(email.cart_id)) ?? []), email.seller_id]);
    }
  const sales = new Set<string>();
  for (const purchase of purchases) {
    const orderId = orderOf.get(String(purchase.id));
    if (orderId === undefined || !orders.has(String(orderId))) continue;
    const cartId = cartOf.get(String(orderId));
    if (cartId === undefined) continue;
    const productSeller = linkById.get(String(purchase.link_id))!.user_id;
    if ((emailSellers.get(String(cartId)) ?? []).some((seller) => String(seller) === String(productSeller)))
      sales.add(String(purchase.id));
  }
  return sales;
}

async function idsWithRows(
  tableName: string,
  columnName: string,
  purchaseIds: readonly bigint[],
): Promise<Set<string>> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column(tableName, columnName)} AS id FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${Prisma.join(purchaseIds)})`,
  );
  return new Set(rows.map((row) => String(row.id)));
}

// The names `PurchaseExportService#custom_fields` collects (the purchases' own, then their product's), in purchase order.
export type PurchaseExportData = { customFields: string[]; rows: PurchaseDataRow[] };

export async function purchaseExportData(purchases: readonly Purchase[]): Promise<PurchaseExportData> {
  if (purchases.length === 0) return { customFields: [], rows: [] };
  const purchaseIds = purchases.map((purchase) => purchase.id);

  // purchase.gift_given for the sales of a gift: its giftee's email, and its giftee's purchase for the review and the license key.
  const gifts = await selectRows<GiftRow>(
    Prisma.sql`SELECT ${column("gifts", "gifter_purchase_id")}, ${column("gifts", "giftee_purchase_id")}, ${column("gifts", "giftee_email")} FROM ${table("gifts")} WHERE ${column("gifts", "gifter_purchase_id")} IN (${Prisma.join(purchaseIds)}) OR ${column("gifts", "giftee_purchase_id")} IN (${Prisma.join(purchaseIds)}) ORDER BY ${column("gifts", "id")}`,
  );
  const giftBySender = new Map<string, GiftRow>();
  const inExport = new Set(purchaseIds.map(String));
  for (const gift of gifts) {
    if (gift.gifter_purchase_id === null || gift.giftee_purchase_id === null)
      throw new HandBackToRails("a gift without a sender or a receiver");
    // The export leaves out a gift's receiver, so one in it is not a shape the search produces.
    if (inExport.has(String(gift.giftee_purchase_id)))
      throw new HandBackToRails("an export that holds a gift receiver");
    if (giftBySender.has(String(gift.gifter_purchase_id))) throw new HandBackToRails("a sale with several gifts");
    giftBySender.set(String(gift.gifter_purchase_id), gift);
  }
  for (const purchase of purchases)
    if (flagSet(purchase, "is_gift_sender_purchase") !== giftBySender.has(String(purchase.id)))
      throw new HandBackToRails("a sale whose gift flag and gift row disagree");
  const gifteeIds = [...new Set(gifts.map((gift) => gift.giftee_purchase_id!))];
  const gifteeOf = new Map<string, bigint>(
    gifts.map((gift) => [String(gift.gifter_purchase_id), gift.giftee_purchase_id!]),
  );
  if (gifteeIds.length > 0) {
    // The review and the license key are read from the giftee's purchase: it must be a plain sale of the same product.
    const giftees = await selectRows<{ id: bigint; link_id: bigint | null; subscription_id: bigint | null }>(
      Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "link_id")}, ${column("purchases", "subscription_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} IN (${Prisma.join(gifteeIds)})`,
    );
    const gifteeById = new Map(giftees.map((giftee) => [String(giftee.id), giftee]));
    for (const purchase of purchases) {
      if (!giftBySender.has(String(purchase.id))) continue;
      const giftee = gifteeById.get(String(gifteeOf.get(String(purchase.id))));
      if (giftee === undefined) throw new HandBackToRails("a gift whose receiver's purchase is missing");
      if (giftee.link_id !== purchase.link_id || giftee.subscription_id !== null)
        throw new HandBackToRails("a gift whose receiver's purchase is not a plain sale of the same product");
    }
    if ((await idsWithRows("base_variants_purchases", "purchase_id", gifteeIds)).size > 0)
      throw new HandBackToRails("a gift whose receiver's purchase holds a variant");
  }
  // purchase.preorder.created_at for a pre-order's charge
  const preorderIds = [
    ...new Set(purchases.map((purchase) => purchase.preorder_id).filter((id): id is bigint => id !== null)),
  ];
  const preorderTimes = new Map<string, Date>();
  if (preorderIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; created_at: Date }>(
      Prisma.sql`SELECT ${column("preorders", "id")}, ${column("preorders", "created_at")} FROM ${table("preorders")} WHERE ${column("preorders", "id")} IN (${Prisma.join(preorderIds)})`,
    ))
      preorderTimes.set(String(row.id), row.created_at);
    if (preorderTimes.size !== preorderIds.length) throw new HandBackToRails("a sale whose pre-order is missing");
  }

  const linkIds = [...new Set(purchases.map((purchase) => purchase.link_id))];
  if (linkIds.some((id) => id === null)) throw new HandBackToRails("a sale whose product is missing");
  const links = await selectRows<{
    id: bigint;
    user_id: bigint | null;
    name: string | null;
    unique_permalink: string | null;
    flags: bigint;
  }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "name")}, ${column("links", "unique_permalink")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(linkIds)})`,
  );
  const linkById = new Map(links.map((link) => [String(link.id), link]));
  if (linkById.size !== linkIds.length) throw new HandBackToRails("a sale whose product is missing");
  const abandonedCartEmailSales = await salesWithAbandonedCartEmail(purchases, linkById);

  // `variant_attributes` has no order of its own, so one variant per sale is proven. A tiered membership prices its variant from the
  // subscription's recurrence, and its sale holds a subscription, which hands back below.
  const variantRows = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${column("base_variants_purchases", "purchase_id")}, ${column("base_variants", "id")}, ${column("base_variants", "type")}, ${column("base_variants", "name")}, ${column("base_variants", "price_difference_cents")}, ${column("base_variants", "custom_sku")}, ${column("base_variants", "flags")} FROM ${table("base_variants_purchases")} INNER JOIN ${table("base_variants")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} IN (${Prisma.join(purchaseIds)})`,
  );
  const variantByPurchase = new Map<string, VariantRow>();
  for (const variant of variantRows) {
    if (variantByPurchase.has(String(variant.purchase_id)))
      throw new HandBackToRails("an export that holds a sale with several variants");
    variantByPurchase.set(String(variant.purchase_id), variant);
  }
  if (variantRows.length > 0 && links.some((link) => LinkFlags.isSet(link.flags, "is_tiered_membership")))
    throw new HandBackToRails("an export that holds a variant of a tiered membership");

  // link.custom_fields has no order of its own, so only one field per product is proven.
  const productFields = await selectRows<{ link_id: bigint; name: string | null }>(
    Prisma.sql`SELECT ${column("custom_fields_products", "product_id")} AS link_id, ${column("custom_fields", "name")} FROM ${table("custom_fields")} INNER JOIN ${table("custom_fields_products")} ON ${column("custom_fields", "id")} = ${column("custom_fields_products", "custom_field_id")} WHERE ${column("custom_fields_products", "product_id")} IN (${Prisma.join(linkIds)}) ORDER BY ${column("custom_fields", "id")}`,
  );
  const productFieldNames = new Map<string, string[]>();
  for (const field of productFields) {
    const names = productFieldNames.get(String(field.link_id)) ?? [];
    names.push(field.name ?? "");
    productFieldNames.set(String(field.link_id), names);
  }
  if ([...productFieldNames.values()].some((names) => names.length > 1))
    throw new HandBackToRails("a product with several custom fields, whose column order is unspecified");

  const answers = await selectRows<CustomFieldRow>(
    Prisma.sql`SELECT ${column("purchase_custom_fields", "purchase_id")}, ${column("purchase_custom_fields", "name")}, ${column("purchase_custom_fields", "value")}, ${column("purchase_custom_fields", "field_type")} FROM ${table("purchase_custom_fields")} WHERE ${column("purchase_custom_fields", "purchase_id")} IN (${Prisma.join(purchaseIds)}) ORDER BY ${column("purchase_custom_fields", "id")}`,
  );
  const answersByPurchase = new Map<string, CustomFieldRow[]>();
  for (const answer of answers) {
    const list = answersByPurchase.get(String(answer.purchase_id)) ?? [];
    list.push(answer);
    answersByPurchase.set(String(answer.purchase_id), list);
  }

  const refunds = await selectRows<RefundRow>(
    Prisma.sql`SELECT ${column("refunds", "purchase_id")}, ${column("refunds", "amount_cents")}, ${column("refunds", "json_data")} FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} IN (${Prisma.join(purchaseIds)}) AND (${column("refunds", "status")} IS NULL OR ${column("refunds", "status")} NOT IN (${Prisma.join(TERMINAL_FAILURE_STATUSES)}) OR COALESCE(${column("refunds", "json_data")}->>'$.balance_reversed_on_failure', 'false') != 'true')`,
  );
  const refundedCents = new Map<string, number>();
  for (const refund of refunds)
    refundedCents.set(
      String(refund.purchase_id),
      (refundedCents.get(String(refund.purchase_id)) ?? 0) + Number(refund.amount_cents ?? 0),
    );

  // Purchase#buyer_presentment_refunded_cents_incomplete? reads every sale's refunds, so a json_data Rails cannot read fails them all.
  const snapshotsByPurchase = new Map<string, (number | null)[]>();
  for (const refund of refunds)
    snapshotsByPurchase.set(String(refund.purchase_id), [
      ...(snapshotsByPurchase.get(String(refund.purchase_id)) ?? []),
      snapshotCents(refund),
    ]);
  const presentments = new Map<string, Presentment>();
  for (const row of await selectRows<PresentmentRow>(
    Prisma.sql`SELECT ${column("purchase_presentments", "purchase_id")}, ${column("purchase_presentments", "presentment_currency")}, ${column("purchase_presentments", "presentment_total_cents")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} IN (${Prisma.join(purchaseIds)})`,
  )) {
    const key = String(row.purchase_id);
    const snapshots = snapshotsByPurchase.get(key) ?? [];
    presentments.set(key, {
      currency: row.presentment_currency ?? "",
      totalCents: Number(row.presentment_total_cents),
      // Refund#presentment_snapshot?: a currency and a positive amount. Only snapshots add to the total.
      refundedCents: snapshots.reduce<number>((sum, cents) => sum + (cents ?? 0), 0),
      refundsIncomplete: snapshots.some((cents) => cents === null),
    });
  }

  const offerCodeIds = [
    ...new Set(purchases.map((purchase) => purchase.offer_code_id).filter((id): id is bigint => id !== null)),
  ];
  const offerCodes = new Map<string, string | null>();
  if (offerCodeIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; code: string | null }>(
      Prisma.sql`SELECT ${column("offer_codes", "id")}, ${column("offer_codes", "code")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} IN (${Prisma.join(offerCodeIds)})`,
    ))
      offerCodes.set(String(row.id), row.code);
    if (offerCodes.size !== offerCodeIds.length) throw new HandBackToRails("a sale whose offer code is missing");
  }

  const purchaserIds = [
    ...new Set(purchases.map((purchase) => purchase.purchaser_id).filter((id): id is bigint => id !== null)),
  ];
  const purchasers = new Map<string, { name: string | null; email: string | null }>();
  if (purchaserIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; name: string | null; email: string | null }>(
      Prisma.sql`SELECT ${column("users", "id")}, ${column("users", "name")}, ${column("users", "email")} FROM ${table("users")} WHERE ${column("users", "id")} IN (${Prisma.join(purchaserIds)})`,
    ))
      purchasers.set(String(row.id), row);
    if (purchasers.size !== purchaserIds.length) throw new HandBackToRails("a sale whose buyer is missing");
  }

  const zipTaxRateIds = [
    ...new Set(purchases.map((purchase) => purchase.zip_tax_rate_id).filter((id): id is bigint => id !== null)),
  ];
  const taxCountries = new Map<string, string | null>();
  if (zipTaxRateIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; country: string | null }>(
      Prisma.sql`SELECT ${column("zip_tax_rates", "id")}, ${column("zip_tax_rates", "country")} FROM ${table("zip_tax_rates")} WHERE ${column("zip_tax_rates", "id")} IN (${Prisma.join(zipTaxRateIds)})`,
    ))
      taxCountries.set(String(row.id), row.country);
  }

  const tips = await selectRows<{ purchase_id: bigint; value_usd_cents: number | null }>(
    Prisma.sql`SELECT ${column("tips", "purchase_id")}, ${column("tips", "value_usd_cents")} FROM ${table("tips")} WHERE ${column("tips", "purchase_id")} IN (${Prisma.join(purchaseIds)}) ORDER BY ${column("tips", "id")}`,
  );
  // has_one :tip reads the first row; a second tip on one sale is not proven.
  const tipCents = new Map<string, number>();
  for (const tip of tips) {
    if (tipCents.has(String(tip.purchase_id))) throw new HandBackToRails("a sale with several tips");
    tipCents.set(String(tip.purchase_id), tip.value_usd_cents ?? 0);
  }

  // original_product_review: the sale's own review (a subscription hands back), the giftee's for a gift the buyer sent.
  const lookupIds = [...purchaseIds, ...gifteeIds];
  const reviews = await selectRows<{ purchase_id: bigint; rating: number | null; message: string | null }>(
    Prisma.sql`SELECT ${column("product_reviews", "purchase_id")}, ${column("product_reviews", "rating")}, ${column("product_reviews", "message")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} IN (${Prisma.join(lookupIds)})`,
  );
  const reviewByPurchase = new Map(reviews.map((review) => [String(review.purchase_id), review]));

  const licenseRows = await selectRows<LicenseRow>(
    Prisma.sql`SELECT ${column("licenses", "purchase_id")}, ${column("licenses", "serial")}, ${column("licenses", "uses")}, ${column("licenses", "disabled_at")} FROM ${table("licenses")} WHERE ${column("licenses", "purchase_id")} IN (${Prisma.join(lookupIds)}) ORDER BY ${column("licenses", "id")}`,
  );
  const licenseByPurchase = new Map<string, LicenseRow>();
  for (const license of licenseRows) {
    if (licenseByPurchase.has(String(license.purchase_id))) throw new HandBackToRails("a sale with several licenses");
    licenseByPurchase.set(String(license.purchase_id), license);
  }
  // Purchase#variant_content_permits_license_key? reads the variants' rich content, which is not ported.
  for (const purchase of purchases) {
    const link = linkById.get(String(purchase.link_id))!;
    if (LinkFlags.isSet(link.flags, "is_licensed") && variantByPurchase.has(String(purchase.id)))
      throw new HandBackToRails("a licensed product's sale with a variant");
  }

  const upsold = await idsWithRows("upsell_purchases", "purchase_id", purchaseIds);
  // purchase.utm_link, through its one driven sale
  const utmRows = await selectRows<UtmRow>(
    Prisma.sql`SELECT ${column("utm_link_driven_sales", "purchase_id")}, ${column("utm_links", "utm_source")}, ${column("utm_links", "utm_medium")}, ${column("utm_links", "utm_campaign")}, ${column("utm_links", "utm_term")}, ${column("utm_links", "utm_content")} FROM ${table("utm_link_driven_sales")} INNER JOIN ${table("utm_links")} ON ${column("utm_links", "id")} = ${column("utm_link_driven_sales", "utm_link_id")} WHERE ${column("utm_link_driven_sales", "purchase_id")} IN (${Prisma.join(purchaseIds)})`,
  );
  const utmByPurchase = new Map<string, UtmRow>();
  for (const utm of utmRows) {
    if (utmByPurchase.has(String(utm.purchase_id))) throw new HandBackToRails("a sale driven by several UTM links");
    utmByPurchase.set(String(utm.purchase_id), utm);
  }

  // purchase.affiliate&.affiliate_user&.form_email
  const affiliateIds = [
    ...new Set(purchases.map((purchase) => purchase.affiliate_id).filter((id): id is bigint => id !== null)),
  ];
  const affiliateEmails = new Map<string, string | null>();
  if (affiliateIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; unconfirmed_email: string | null; email: string | null }>(
      Prisma.sql`SELECT ${column("affiliates", "id")}, ${column("users", "unconfirmed_email")}, ${column("users", "email")} FROM ${table("affiliates")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("affiliates", "affiliate_user_id")} WHERE ${column("affiliates", "id")} IN (${Prisma.join(affiliateIds)})`,
    ))
      affiliateEmails.set(String(row.id), presence(row.unconfirmed_email) ?? presence(row.email));
    // An affiliate whose row or user is gone reads as no affiliate in Rails; not proven here.
    if (affiliateEmails.size !== affiliateIds.length)
      throw new HandBackToRails("a sale whose affiliate or its user is missing");
  }

  // MerchantAccount#is_a_stripe_connect_account?
  const connectAccountIds = new Set<string>();
  const merchantAccountIds = [
    ...new Set(purchases.map((purchase) => purchase.merchant_account_id).filter((id): id is bigint => id !== null)),
  ];
  if (merchantAccountIds.length > 0) {
    for (const account of await selectRows<{
      id: bigint;
      user_id: bigint | null;
      charge_processor_id: string | null;
      json_data: string | null;
    }>(
      Prisma.sql`SELECT ${column("merchant_accounts", "id")}, ${column("merchant_accounts", "user_id")}, ${column("merchant_accounts", "charge_processor_id")}, ${column("merchant_accounts", "json_data")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} IN (${Prisma.join(merchantAccountIds)})`,
    ))
      if (isStripeConnectAccount(account)) connectAccountIds.add(String(account.id));
  }

  const customFields: string[] = [];
  const addCustomField = (name: string) => {
    if (!customFields.includes(name)) customFields.push(name);
  };
  const rows: PurchaseDataRow[] = [];

  for (const purchase of purchases) {
    const link = linkById.get(String(purchase.link_id))!;
    const key = String(purchase.id);
    // main_or_giftee_purchase
    const readKey = gifteeOf.has(key) ? String(gifteeOf.get(key)) : key;
    const answered = answersByPurchase.get(key) ?? [];
    const customFieldValues = new Map<string, string | boolean | null>();
    for (const answer of answered) {
      const name = answer.name ?? "";
      const value = BOOLEAN_FIELD_TYPES.includes(answer.field_type ?? "")
        ? castBoolean(answer.value)
        : (answer.value ?? "");
      if ((typeof value === "string" && !inspectsRaw(value)) || !inspectsRaw(name))
        throw new HandBackToRails("a custom field whose String#inspect escapes a non-ASCII character");
      customFieldValues.set(name, value);
      addCustomField(name);
    }
    for (const name of productFieldNames.get(String(purchase.link_id)) ?? []) addCustomField(name);

    rows.push({
      fields: purchaseFields(purchase, link, {
        purchasers,
        offerCodes,
        refundedCents,
        customFieldValues,
        variant: variantByPurchase.get(key),
        taxCountries,
        affiliateEmails,
        tipCents: tipCents.get(key),
        review: reviewByPurchase.get(readKey),
        license: licenseByPurchase.get(readKey),
        giftee: giftBySender.get(key),
        preorderTime: purchase.preorder_id === null ? undefined : preorderTimes.get(String(purchase.preorder_id)),
        upsold: upsold.has(key),
        utm: utmByPurchase.get(key),
        connectAccountIds,
        presentments,
        abandonedCartEmailSales,
      }),
      customFields: Object.fromEntries(customFieldValues) as Record<string, CsvCell>,
    });
  }
  return { customFields, rows };
}

// ActiveModel::Type::Boolean#cast
function castBoolean(value: string | null): boolean | null {
  if (value === null || value === "") return null;
  return !["0", "f", "F", "false", "FALSE", "off", "OFF"].includes(value);
}

function purchaseFields(
  purchase: Purchase,
  link: { name: string | null; unique_permalink: string | null; flags: bigint },
  lookups: {
    purchasers: Map<string, { name: string | null; email: string | null }>;
    offerCodes: Map<string, string | null>;
    refundedCents: Map<string, number>;
    customFieldValues: Map<string, string | boolean | null>;
    variant: VariantRow | undefined;
    taxCountries: Map<string, string | null>;
    affiliateEmails: Map<string, string | null>;
    tipCents: number | undefined;
    review: { rating: number | null; message: string | null } | undefined;
    license: LicenseRow | undefined;
    giftee: GiftRow | undefined;
    preorderTime: Date | undefined;
    upsold: boolean;
    utm: UtmRow | undefined;
    connectAccountIds: ReadonlySet<string>;
    presentments: ReadonlyMap<string, Presentment>;
    abandonedCartEmailSales: ReadonlySet<string>;
  },
): Record<string, CsvCell> {
  for (const [name, reason] of [["is_gift_receiver_purchase", "a gift receiver"]] as const)
    if (flagSet(purchase, name)) throw new HandBackToRails(`an export that holds ${reason}`);
  if (purchase.subscription_id !== null) throw new HandBackToRails("an export that holds a subscription charge");
  if (
    purchase.price_cents === null ||
    purchase.fee_cents === null ||
    purchase.tax_cents === null ||
    purchase.gumroad_tax_cents === null
  )
    throw new HandBackToRails("a sale with an amount that is missing");
  if (purchase.state === null || purchase.country === null)
    throw new HandBackToRails("a sale whose state or country comes from its IP address");
  if (purchase.created_at === null) throw new HandBackToRails("a sale without a creation time");

  const presentment = lookups.presentments.get(String(purchase.id));
  const paypal = presence(purchase.paypal_order_id) !== null;
  const connect =
    purchase.merchant_account_id !== null && lookups.connectAccountIds.has(String(purchase.merchant_account_id));
  const priceDollars = dollars(purchase.price_cents);
  // Purchase#variant_extra_cost_dollars: the price differences, nil counting as nothing.
  const variantsPriceDollars = dollars(lookups.variant?.price_difference_cents ?? 0);
  // Purchase#has_tax_label?, #tax_label(include_tax_rate: false): the named tax of the rate's country, else "Sales tax".
  const hasTaxLabel =
    flagSet(purchase, "was_purchase_taxable") || purchase.gumroad_tax_cents > 0 || purchase.tax_cents > 0;
  const taxCountry =
    purchase.zip_tax_rate_id === null ? null : (lookups.taxCountries.get(String(purchase.zip_tax_rate_id)) ?? null);
  const namedTax =
    taxCountry !== null &&
    [
      EU_VAT_APPLICABLE_COUNTRY_CODES,
      NORWAY_VAT_APPLICABLE_COUNTRY_CODES,
      COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
      COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
      GST_APPLICABLE_COUNTRY_CODES,
    ].some((codes) => codes.has(taxCountry));
  const taxLabel = !hasTaxLabel ? "" : namedTax ? taxNameFor(taxCountry) : "Sales tax";
  const taxable = flagSet(purchase, "was_purchase_taxable");
  const sku = lookups.variant?.type === "Sku" ? lookups.variant : undefined;
  const buyer = purchase.purchaser_id === null ? undefined : lookups.purchasers.get(String(purchase.purchaser_id));
  const refunded = flagSetColumn(purchase.stripe_refunded);
  const partiallyRefunded = flagSetColumn(purchase.stripe_partially_refunded);
  const offerCode =
    purchase.offer_code_id === null ? null : (lookups.offerCodes.get(String(purchase.offer_code_id)) ?? null);

  return {
    "Purchase ID": encrypt(purchase.id),
    "Item Name": link.name,
    "Buyer Name": presence(purchase.full_name) ?? buyer?.name ?? null,
    "Purchase Email": purchase.email,
    "Buyer Email": buyer?.email ?? null,
    "Do not contact?": purchase.can_contact === true ? 0 : 1,
    "Purchase Date": dateOf(purchase.created_at),
    "Purchase Time (UTC timezone)": timeOf(purchase.created_at),
    "Subtotal ($)": dollars(purchase.price_cents - purchase.tax_cents - (purchase.shipping_cents ?? 0)),
    // Purchase#tax_dollars
    "Taxes ($)": dollars(purchase.gumroad_tax_cents > 0 ? purchase.gumroad_tax_cents : purchase.tax_cents),
    "Tax Type": taxLabel,
    "Shipping ($)": dollars(purchase.shipping_cents),
    "Sale Price ($)": priceDollars,
    "Fees ($)": dollars(purchase.fee_cents),
    // (tip&.value_usd_cents || 0) / 100.0, not rounded
    "Tip ($)": new RubyFloat((lookups.tipCents ?? 0) / CENTS_PER_DOLLAR),
    "Net Total ($)": dollars(purchase.price_cents - purchase.fee_cents),
    "Tax Included in Price?": taxable ? (flagSet(purchase, "was_tax_excluded_from_price") ? 0 : 1) : null,
    "Street Address": pseudoTransliterate(purchase.street_address),
    City: pseudoTransliterate(purchase.city),
    "Zip Code": zipCodeForExport(purchase.zip_code),
    State: pseudoTransliterate(purchase.state),
    Country: pseudoTransliterate(purchase.country),
    Referrer: purchase.referrer,
    "Refunded?": refunded || partiallyRefunded ? 1 : 0,
    "Partial Refund ($)": partiallyRefunded
      ? dollars(lookups.refundedCents.get(String(purchase.id)) ?? 0)
      : new RubyFloat(0),
    "Fully Refunded?": refunded ? 1 : 0,
    "Disputed?": purchase.chargeback_date === null ? 0 : 1,
    "Dispute Won?": flagSet(purchase, "chargeback_reversed") ? 1 : 0,
    "Access Revoked?": flagSet(purchase, "is_access_revoked") ? 1 : 0,
    Variants: variantsDisplayable(lookups.variant),
    "Discount Code": offerCode,
    "Recurring Charge?": 0,
    "Free trial purchase?": flagSet(purchase, "is_free_trial_purchase") ? 1 : 0,
    "Pre-order authorization?": flagSet(purchase, "is_preorder_authorization") ? 1 : 0,
    "Product ID": link.unique_permalink,
    "Order Number": encryptNumeric(Number(purchase.id)),
    // is_preorder_charge?: a pre-order's purchase that is not its authorization
    "Pre-order authorization time (UTC timezone)":
      purchase.preorder_id !== null && !flagSet(purchase, "is_preorder_authorization")
        ? timeOf(lookups.preorderTime!)
        : null,
    "Custom Fields": hashInspect(lookups.customFieldValues),
    "Item Price ($)": new RubyFloat(priceDollars.value - variantsPriceDollars.value),
    "Variants Price ($)": variantsPriceDollars,
    "Giftee Email": presence(lookups.giftee?.giftee_email ?? null),
    // Sku#custom_name_or_external_id
    "SKU ID": sku === undefined ? null : (presence(sku.custom_sku) ?? encrypt(sku.id)),
    Quantity: purchase.quantity,
    Recurrence: null,
    Affiliate:
      purchase.affiliate_id === null ? null : (lookups.affiliateEmails.get(String(purchase.affiliate_id)) ?? null),
    "Affiliate commission ($)":
      purchase.affiliate_credit_cents === null ? null : dollars(purchase.affiliate_credit_cents),
    "Discover?": flagSet(purchase, "was_product_recommended") ? 1 : 0,
    "Cancellation Date": null,
    "Subscription End Date": null,
    Rating: lookups.review?.rating ?? null,
    Review: lookups.review?.message ?? null,
    // Purchase#license_key: only a licensed product shows its serial.
    "License Key": LinkFlags.isSet(link.flags, "is_licensed") ? (lookups.license?.serial ?? null) : null,
    "License Key Activation Count": lookups.license === undefined ? null : (lookups.license.uses ?? null),
    "License Key Enabled?": lookups.license === undefined ? null : lookups.license.disabled_at === null ? 1 : 0,
    "Payment Type": paymentTypeLabel(purchase.card_type) ?? null,
    "PayPal Transaction ID": paypal ? purchase.stripe_transaction_id : null,
    "PayPal Fee Amount": paypal ? dollars(purchase.processor_fee_cents) : null,
    "PayPal Fee Currency": paypal ? purchase.processor_fee_cents_currency : null,
    "Stripe Transaction ID": connect ? purchase.stripe_transaction_id : null,
    "Stripe Fee Amount": connect ? dollars(purchase.processor_fee_cents) : null,
    "Stripe Fee Currency": connect ? purchase.processor_fee_cents_currency : null,
    "Purchasing Power Parity Discounted?": flagSet(purchase, "is_purchasing_power_parity_discounted") ? 1 : 0,
    "Upsold?": lookups.upsold ? 1 : 0,
    "Sent Abandoned Cart Email?": lookups.abandonedCartEmailSales.has(String(purchase.id)) ? 1 : 0,
    "UTM Source": lookups.utm?.utm_source ?? null,
    "UTM Medium": lookups.utm?.utm_medium ?? null,
    "UTM Campaign": lookups.utm?.utm_campaign ?? null,
    "UTM Term": lookups.utm?.utm_term ?? null,
    "UTM Content": lookups.utm?.utm_content ?? null,
    "Buyer Currency": presentment === undefined ? null : presentment.currency.toUpperCase(),
    "Buyer Total": presentment === undefined ? null : buyerMajorUnits(presentment.totalCents, presentment.currency),
    "Buyer Refunded Total":
      presentment === undefined || presentment.refundsIncomplete
        ? null
        : buyerMajorUnits(presentment.refundedCents, presentment.currency),
  };
}

// MerchantAccount#is_a_stripe_connect_account?: `stripe_charge_processor? && user_id.present? && json_data.dig("meta", "stripe_connect") == "true"`.
// The dig is only reached for a Stripe account of a user; a json_data that is not a hash, or a meta that is not one, raises in Rails.
function isStripeConnectAccount(account: {
  user_id: bigint | null;
  charge_processor_id: string | null;
  json_data: string | null;
}): boolean {
  if (account.charge_processor_id !== "stripe" || account.user_id === null) return false;
  let meta: unknown;
  try {
    const data: unknown = account.json_data === null ? null : JSON.parse(account.json_data);
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("not a hash");
    meta = (data as Record<string, unknown>).meta;
    if (meta !== undefined && meta !== null && (typeof meta !== "object" || Array.isArray(meta)))
      throw new Error("not a hash");
  } catch {
    throw new HandBackToRails("a merchant account whose json_data or meta is not a hash");
  }
  return meta !== undefined && meta !== null && (meta as Record<string, unknown>).stripe_connect === "true";
}

const isBlank = (value: string | null): boolean => value === null || value.trim() === "";

// Refund#presentment_snapshot? and #presentment_amount_cents.to_i, both read from the refund's json_data.
function snapshotCents(refund: RefundRow): number | null {
  let currency: unknown;
  let cents: unknown;
  try {
    const data: unknown = refund.json_data === null || refund.json_data === "" ? {} : JSON.parse(refund.json_data);
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("not a hash");
    ({ presentment_currency: currency, presentment_amount_cents: cents } = data as Record<string, unknown>);
    if (((currency ?? "") !== "" && typeof currency !== "string") || (cents != null && !Number.isSafeInteger(cents)))
      throw new Error("not a plain value");
  } catch {
    throw new HandBackToRails("a refund whose json_data Rails reads differently from plain JSON");
  }
  const amount = Number(cents ?? 0);
  return typeof currency === "string" && !isBlank(currency) && amount > 0 ? amount : null;
}

// Purchase#buyer_presentment_major_units: Stripe's charge units to a plain number, a whole Integer for a zero-decimal currency.
function buyerMajorUnits(cents: number, currency: string): number | RubyFloat {
  let scaling: number;
  try {
    scaling = chargeSubunitToUnit(currency);
  } catch (error) {
    if (error instanceof UnknownCurrency)
      throw new HandBackToRails("a buyer-currency charge in a currency Money does not know");
    throw error;
  }
  return scaling === 1 ? cents : new RubyFloat(rubyRoundHalfUp(cents / scaling));
}

const presence = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value);
const flagSetColumn = (value: boolean | null): boolean => value === true;
