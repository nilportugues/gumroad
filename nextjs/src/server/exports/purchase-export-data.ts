// Port of Exports::PurchaseExportService#purchases_data and #purchase_data (app/services/exports/purchase_export_service.rb) for the sales
// the port can prove: a plain sale of a product without variants, whose columns come from the purchase row, its buyer, its offer code, its
// refunds and its custom fields. A sale that needs anything else (tax labels, gifts, pre-orders, subscriptions, licenses, reviews, tips,
// affiliates, UTM links, upsells, carts, buyer-currency or PayPal and Connect charges, variants, a GeoIP lookup or a transliterated address)
// throws HandBackToRails: the export is a read, so Rails serves the whole request and nothing is half done.
import { Prisma, type Purchase } from "@prisma/client";

import type { CsvCell } from "../../lib/csv-safe.ts";
import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import { rubyInspect } from "../models/concerns/ruby-values.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { type PurchaseDataRow, paymentTypeLabel, zipCodeForExport } from "./purchase-export.ts";

const CENTS_PER_DOLLAR = 100;
// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];
// CustomField::BOOLEAN_TYPES
const BOOLEAN_FIELD_TYPES = ["terms", "checkbox"];
const NON_ASCII = /[^\x20-\x7e]/u;

// Tables that make a sale leave the plain path when they hold a row for it. Each is read once for the whole export.
const PURCHASE_ID_TABLES: readonly [string, string, string][] = [
  ["gifts", "gifter_purchase_id", "a gift"],
  ["gifts", "giftee_purchase_id", "a gift"],
  ["licenses", "purchase_id", "a license"],
  ["product_reviews", "purchase_id", "a review"],
  ["tips", "purchase_id", "a tip"],
  ["purchase_presentments", "purchase_id", "a buyer-currency charge"],
  ["upsell_purchases", "purchase_id", "an upsell"],
  ["utm_link_driven_sales", "purchase_id", "a UTM link"],
  ["base_variants_purchases", "purchase_id", "a variant"],
  ["order_purchases", "purchase_id", "a cart"],
];

// convert_cents_to_dollars: (cents.to_f / 100).round(2)
const dollars = (cents: number | null | undefined): RubyFloat =>
  new RubyFloat(rubyRoundHalfUp((cents ?? 0) / CENTS_PER_DOLLAR));

const flagSet = (purchase: Purchase, name: Parameters<typeof PurchaseFlags.isSet>[1]): boolean =>
  PurchaseFlags.isSet(purchase.flags, name);

type CustomFieldRow = { purchase_id: bigint; name: string | null; value: string | null; field_type: string | null };
type RefundRow = { purchase_id: bigint; amount_cents: number | null };

const pad = (value: number) => String(value).padStart(2, "0");
const dateOf = (value: Date) => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
// Time#to_s of a UTC time on a server whose zone is UTC.
const timeOf = (value: Date) =>
  `${dateOf(value)} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} +0000`;

// Hash#inspect of {name => value}, for the "Custom Fields" cell.
function hashInspect(entries: Map<string, string | boolean>): string {
  if (entries.size === 0) return "{}";
  const parts = [...entries].map(
    ([name, value]) => `${rubyInspect(name)} => ${typeof value === "boolean" ? String(value) : rubyInspect(value)}`,
  );
  return `{${parts.join(", ")}}`;
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

  for (const [tableName, columnName, reason] of PURCHASE_ID_TABLES) {
    const hits = await idsWithRows(tableName, columnName, purchaseIds);
    if (purchases.some((purchase) => hits.has(String(purchase.id))))
      throw new HandBackToRails(`an export that holds a sale with ${reason}`);
  }

  const linkIds = [...new Set(purchases.map((purchase) => purchase.link_id))];
  if (linkIds.some((id) => id === null)) throw new HandBackToRails("a sale whose product is missing");
  const links = await selectRows<{ id: bigint; name: string | null; unique_permalink: string | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "unique_permalink")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(linkIds)})`,
  );
  const linkById = new Map(links.map((link) => [String(link.id), link]));
  if (linkById.size !== linkIds.length) throw new HandBackToRails("a sale whose product is missing");

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
    Prisma.sql`SELECT ${column("refunds", "purchase_id")}, ${column("refunds", "amount_cents")} FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} IN (${Prisma.join(purchaseIds)}) AND (${column("refunds", "status")} IS NULL OR ${column("refunds", "status")} NOT IN (${Prisma.join(TERMINAL_FAILURE_STATUSES)}) OR COALESCE(${column("refunds", "json_data")}->>'$.balance_reversed_on_failure', 'false') != 'true')`,
  );
  const refundedCents = new Map<string, number>();
  for (const refund of refunds)
    refundedCents.set(
      String(refund.purchase_id),
      (refundedCents.get(String(refund.purchase_id)) ?? 0) + Number(refund.amount_cents ?? 0),
    );

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

  // charged_using_stripe_connect_account?: the merchant account belongs to a seller.
  const merchantAccountIds = [
    ...new Set(purchases.map((purchase) => purchase.merchant_account_id).filter((id): id is bigint => id !== null)),
  ];
  if (merchantAccountIds.length > 0) {
    const connected = await selectRows(
      Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} IN (${Prisma.join(merchantAccountIds)}) AND ${column("merchant_accounts", "user_id")} IS NOT NULL LIMIT 1`,
    );
    if (connected.length > 0)
      throw new HandBackToRails("an export that holds a sale charged on a seller's own merchant account");
  }

  const customFields: string[] = [];
  const addCustomField = (name: string) => {
    if (!customFields.includes(name)) customFields.push(name);
  };
  const rows: PurchaseDataRow[] = [];

  for (const purchase of purchases) {
    const link = linkById.get(String(purchase.link_id))!;
    const key = String(purchase.id);
    const answered = answersByPurchase.get(key) ?? [];
    const customFieldValues = new Map<string, string | boolean>();
    for (const answer of answered) {
      const name = answer.name ?? "";
      const value = BOOLEAN_FIELD_TYPES.includes(answer.field_type ?? "")
        ? castBoolean(answer.value)
        : (answer.value ?? "");
      if (value === null) throw new HandBackToRails("a checkbox answer that casts to nil");
      if (typeof value === "string" && NON_ASCII.test(value))
        throw new HandBackToRails("a custom field value that is not ASCII");
      if (NON_ASCII.test(name)) throw new HandBackToRails("a custom field name that is not ASCII");
      customFieldValues.set(name, value);
      addCustomField(name);
    }
    for (const name of productFieldNames.get(String(purchase.link_id)) ?? []) addCustomField(name);

    rows.push({
      fields: purchaseFields(purchase, link, { purchasers, offerCodes, refundedCents, customFieldValues }),
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

function ascii(value: string | null, what: string): string | null {
  if (value !== null && NON_ASCII.test(value)) throw new HandBackToRails(`${what} that Rails transliterates`);
  return value;
}

function purchaseFields(
  purchase: Purchase,
  link: { name: string | null; unique_permalink: string | null },
  lookups: {
    purchasers: Map<string, { name: string | null; email: string | null }>;
    offerCodes: Map<string, string | null>;
    refundedCents: Map<string, number>;
    customFieldValues: Map<string, string | boolean>;
  },
): Record<string, CsvCell> {
  for (const [name, reason] of [
    ["is_gift_sender_purchase", "a gift"],
    ["is_gift_receiver_purchase", "a gift"],
    ["is_preorder_authorization", "a pre-order"],
    ["was_purchase_taxable", "a taxable sale"],
  ] as const)
    if (flagSet(purchase, name)) throw new HandBackToRails(`an export that holds ${reason}`);
  if (purchase.preorder_id !== null) throw new HandBackToRails("an export that holds a pre-order");
  if (purchase.subscription_id !== null) throw new HandBackToRails("an export that holds a subscription charge");
  if (purchase.affiliate_id !== null) throw new HandBackToRails("an export that holds an affiliate sale");
  if (purchase.paypal_order_id !== null) throw new HandBackToRails("an export that holds a PayPal sale");
  if (
    purchase.price_cents === null ||
    purchase.fee_cents === null ||
    purchase.tax_cents === null ||
    purchase.gumroad_tax_cents === null
  )
    throw new HandBackToRails("a sale with an amount that is missing");
  if (purchase.tax_cents > 0 || purchase.gumroad_tax_cents > 0)
    throw new HandBackToRails("a sale with tax, whose label Rails derives from the tax rate");
  if (purchase.state === null || purchase.country === null)
    throw new HandBackToRails("a sale whose state or country comes from its IP address");
  if (purchase.created_at === null) throw new HandBackToRails("a sale without a creation time");

  const priceDollars = dollars(purchase.price_cents);
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
    "Taxes ($)": dollars(0),
    "Tax Type": "",
    "Shipping ($)": dollars(purchase.shipping_cents),
    "Sale Price ($)": priceDollars,
    "Fees ($)": dollars(purchase.fee_cents),
    "Tip ($)": new RubyFloat(0),
    "Net Total ($)": dollars(purchase.price_cents - purchase.fee_cents),
    "Tax Included in Price?": null,
    "Street Address": ascii(purchase.street_address, "a street address"),
    City: ascii(purchase.city, "a city"),
    "Zip Code": zipCodeForExport(purchase.zip_code),
    State: ascii(purchase.state, "a state"),
    Country: ascii(purchase.country, "a country"),
    Referrer: purchase.referrer,
    "Refunded?": refunded || partiallyRefunded ? 1 : 0,
    "Partial Refund ($)": partiallyRefunded
      ? dollars(lookups.refundedCents.get(String(purchase.id)) ?? 0)
      : new RubyFloat(0),
    "Fully Refunded?": refunded ? 1 : 0,
    "Disputed?": purchase.chargeback_date === null ? 0 : 1,
    "Dispute Won?": flagSet(purchase, "chargeback_reversed") ? 1 : 0,
    "Access Revoked?": flagSet(purchase, "is_access_revoked") ? 1 : 0,
    Variants: "",
    "Discount Code": offerCode,
    "Recurring Charge?": 0,
    "Free trial purchase?": flagSet(purchase, "is_free_trial_purchase") ? 1 : 0,
    "Pre-order authorization?": 0,
    "Product ID": link.unique_permalink,
    "Order Number": encryptNumeric(Number(purchase.id)),
    "Pre-order authorization time (UTC timezone)": null,
    "Custom Fields": hashInspect(lookups.customFieldValues),
    "Item Price ($)": new RubyFloat(priceDollars.value - 0),
    "Variants Price ($)": new RubyFloat(0),
    "Giftee Email": null,
    "SKU ID": null,
    Quantity: purchase.quantity,
    Recurrence: null,
    Affiliate: null,
    "Affiliate commission ($)":
      purchase.affiliate_credit_cents === null ? null : dollars(purchase.affiliate_credit_cents),
    "Discover?": flagSet(purchase, "was_product_recommended") ? 1 : 0,
    "Cancellation Date": null,
    "Subscription End Date": null,
    Rating: null,
    Review: null,
    "License Key": null,
    "License Key Activation Count": null,
    "License Key Enabled?": null,
    "Payment Type": paymentTypeLabel(purchase.card_type) ?? null,
    "PayPal Transaction ID": null,
    "PayPal Fee Amount": null,
    "PayPal Fee Currency": null,
    "Stripe Transaction ID": null,
    "Stripe Fee Amount": null,
    "Stripe Fee Currency": null,
    "Purchasing Power Parity Discounted?": flagSet(purchase, "is_purchasing_power_parity_discounted") ? 1 : 0,
    "Upsold?": 0,
    "Sent Abandoned Cart Email?": 0,
    "UTM Source": null,
    "UTM Medium": null,
    "UTM Campaign": null,
    "UTM Term": null,
    "UTM Content": null,
    "Buyer Currency": null,
    "Buyer Total": null,
    "Buyer Refunded Total": null,
  };
}

const presence = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value);
const flagSetColumn = (value: boolean | null): boolean => value === true;
