// The `purchase` of a license response in Api::V2::LicensesController#success_with_license:
// `purchase.payload_for_ping_notification.merge(purchase_as_json(purchase))`, where the second hash is the WHITELIST_PURCHASE_ATTRIBUTES
// slice of `Purchase#as_json_for_license`. Only the plain purchase is ported: a gift, preorder, affiliate, offer code, variant, SKU,
// custom field, shipped product or recurring charge raises NotPortedError before anything is written, and the dispatcher hands the
// request to Rails.
import { Prisma } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { findLink, findUserById, type LinkRow, type UserRow } from "../presenters/product-reads.ts";
import { longUrl } from "../presenters/product.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { LinkFlags } from "./link.ts";
import { column, selectRows, table } from "./sql.ts";
import { SubscriptionFlags } from "./subscription.ts";
import { NotPortedError } from "./user.ts";
import { timeJson } from "./purchase-json.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RUBY_REF = "Purchase#payload_for_ping_notification";
const notPorted = (what: string) => new NotPortedError(what, RUBY_REF);
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const truthy = (value: unknown): boolean => value === true || value === 1 || value === 1n;

const exists = async (
  tableName: string,
  columnName: string,
  id: unknown,
  extra: Prisma.Sql = Prisma.empty,
): Promise<boolean> =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, columnName)} = ${id}${extra} LIMIT 1`,
    )
  ).length > 0;

export const findPurchaseRow = async (id: unknown): Promise<Row | null> =>
  (
    await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
    )
  )[0] ?? null;

// Subscription#recurrence for a plain payment option: `last_payment_option`, else the latest alive one.
async function subscriptionRecurrence(subscription: Row): Promise<string> {
  if (SubscriptionFlags.isSet(subscription.flags, "is_installment_plan"))
    throw notPorted("an installment plan subscription");
  const options = await selectRows<Row>(
    subscription.last_payment_option_id == null
      ? Prisma.sql`SELECT ${Prisma.raw("`payment_options`.*")} FROM ${table("payment_options")} WHERE ${column("payment_options", "subscription_id")} = ${subscription.id} AND ${column("payment_options", "deleted_at")} IS NULL ORDER BY ${column("payment_options", "id")} DESC LIMIT 1`
      : Prisma.sql`SELECT ${Prisma.raw("`payment_options`.*")} FROM ${table("payment_options")} WHERE ${column("payment_options", "id")} = ${subscription.last_payment_option_id} LIMIT 1`,
  );
  const option = options[0];
  if (option === undefined || option.product_installment_plan_id != null || option.price_id == null)
    throw notPorted("a subscription with no plain price");
  const [price] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table("prices")} WHERE ${column("prices", "id")} = ${option.price_id} LIMIT 1`,
  );
  if (price === undefined) throw notPorted("a subscription with no price");
  return price.recurrence;
}

export async function licensePurchaseJson(purchase: Row, license: Row): Promise<Record<string, unknown>> {
  const flags = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  const link: LinkRow | null = purchase.link_id == null ? null : await findLink(purchase.link_id);
  const seller: UserRow | null = purchase.seller_id == null ? null : await findUserById(purchase.seller_id);
  const purchaser: UserRow | null = purchase.purchaser_id == null ? null : await findUserById(purchase.purchaser_id);
  if (link === null || seller === null) throw notPorted("a purchase without a product or seller");

  if (flags("is_gift_sender_purchase") || flags("is_gift_receiver_purchase")) throw notPorted("a gift purchase");
  if (flags("is_preorder_authorization") || purchase.preorder_id != null) throw notPorted("a preorder purchase");
  if (
    LinkFlags.isSet(link.flags, "is_physical") ||
    LinkFlags.isSet(link.flags, "skus_enabled") ||
    truthy(link.require_shipping)
  )
    throw notPorted("a shipped or SKU product");
  if (purchase.offer_code_id != null) throw notPorted("an offer code purchase");
  if (purchase.affiliate_id != null || (await exists("affiliate_credits", "purchase_id", purchase.id)))
    throw notPorted("an affiliate purchase");
  if (await exists("base_variants_purchases", "purchase_id", purchase.id)) throw notPorted("a purchase with variants");
  if (await exists("purchase_custom_fields", "purchase_id", purchase.id))
    throw notPorted("a purchase with custom fields");

  const recurringBilling = LinkFlags.isSet(link.flags, "is_recurring_billing");
  let subscription: Row | null = null;
  if (purchase.subscription_id != null) {
    [subscription = null] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${purchase.subscription_id} LIMIT 1`,
    );
    if (subscription === null) throw notPorted("a purchase whose subscription is gone");
    if (!flags("is_original_subscription_purchase")) throw notPorted("a recurring charge");
    // `subscription.custom_fields` delegates to the original purchase, and the ping reads them when the purchase has none.
    if (await exists("purchase_custom_fields", "purchase_id", purchase.id))
      throw notPorted("a subscription with custom fields");
    const [others] = await selectRows<{ total: bigint }>(
      Prisma.sql`SELECT COUNT(*) AS total FROM ${table("purchase_custom_fields")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("purchase_custom_fields", "purchase_id")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id}`,
    );
    if (Number(others?.total ?? 0) > 0) throw notPorted("a subscription with custom fields");
  } else if (recurringBilling) {
    throw notPorted("a recurring product purchase without a subscription");
  }

  // `purchase.license`: the has_one the key is read from; it can differ from the license the request found.
  const [own] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "purchase_id")} = ${purchase.id} ORDER BY ${column("licenses", "id")} ASC LIMIT 1`,
  );
  const licensed = LinkFlags.isSet(link.flags, "is_licensed");
  if (licensed && own !== undefined && String(own.id) !== String(license.id))
    throw notPorted("a purchase with another license");
  const licenseKey = licensed && own !== undefined && present(own.serial) ? own.serial : null;

  const stripeRefunded = purchase.stripe_refunded == null ? null : truthy(purchase.stripe_refunded);
  const chargedBack = purchase.chargeback_date != null;
  const reversed = flags("chargeback_reversed");
  const payload: Record<string, unknown> = {
    seller_id: encrypt(seller.id),
    product_id: encrypt(link.id),
    product_name: link.name,
    permalink: present(link.custom_permalink) ? link.custom_permalink : link.unique_permalink,
    product_permalink: longUrl(link, seller),
    short_product_id: link.unique_permalink,
    email: purchase.email,
    price: purchase.price_cents,
    gumroad_fee: purchase.fee_cents,
    currency: link.price_currency_type,
    quantity: purchase.quantity,
    discover_fee_charged: flags("was_discover_fee_charged"),
    can_contact: truthy(purchase.can_contact),
    referrer: purchase.referrer,
    card: { visual: purchase.card_visual, type: purchase.card_type, bin: null, expiry_month: null, expiry_year: null },
    order_number: encryptNumeric(Number(purchase.id)),
    sale_id: encrypt(purchase.id),
    sale_timestamp: timeJson(purchase.created_at),
  };
  if (present(purchase.full_name)) payload.full_name = purchase.full_name;
  if (purchaser !== null) payload.purchaser_id = purchaser.external_id;
  if (subscription !== null) payload.subscription_id = encrypt(subscription.id);
  if (purchaser !== null && String(purchaser.id) === String(seller.id)) payload.test = true;
  if (licenseKey !== null) {
    payload.license_key = licenseKey;
    payload.is_multiseat_license = flags("is_multiseat_license");
  }
  if (present(purchase.ip_country)) payload.ip_country = purchase.ip_country;
  if (subscription !== null) payload.recurrence = await subscriptionRecurrence(subscription);
  payload.is_gift_receiver_purchase = false;
  payload.refunded = stripeRefunded === true;
  payload.disputed = chargedBack;
  payload.dispute_won = reversed;

  // purchase_as_json: the whitelisted keys of `as_json_for_license` (version 1, so `variants` is a string and `custom_fields` a list).
  const asJson: Record<string, unknown> = {
    id: encrypt(purchase.id),
    created_at: timeJson(purchase.created_at),
    variants: "",
    custom_fields: [],
  };
  if (recurringBilling) {
    // `refunded` is the raw column here, which `delete_if nil` drops.
    if (stripeRefunded !== null) asJson.refunded = stripeRefunded;
    asJson.subscription_ended_at = timeJson(subscription!.ended_at);
    asJson.subscription_cancelled_at = timeJson(subscription!.cancelled_at);
    asJson.subscription_failed_at = timeJson(subscription!.failed_at);
  } else {
    asJson.refunded = stripeRefunded === true;
    asJson.chargebacked = chargedBack && !reversed;
  }
  return { ...payload, ...asJson };
}
