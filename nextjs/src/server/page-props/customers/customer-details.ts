// What CustomersController reads for one sale: `customer_charges`, `customer_emails`, `missed_posts`, `product_purchases` and the
// props `show` adds to the customer (build_charges, build_customer_emails and CustomerPresenter#charge / #missed_posts).
//
// Handed back to Rails (HandBackToRails) when the sale needs a reading the port does not make: a receipt sent through a Charge
// that has a receipt record or a second item, a post whose email info is missing, a subscription purchase without a subscription, and a post whose
// filters Node cannot evaluate.
import { Prisma, type Installment, type Purchase, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails, RoutingError } from "../../controllers/application-controller.ts";
import { cgiEscape } from "../../controllers/rails-query.ts";
import { instantInTimeZoneIso8601 } from "../../models/concerns/rails-time-zone.ts";
import { InstallmentPost } from "../../models/installment-post.ts";
import { PurchaseRecord } from "../../models/purchase-pricing.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { purchasePassesFilters } from "../../models/with-filtering.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { fullUrl } from "../emails/installment-props.ts";

import {
  assertRefundableReadable,
  num,
  refundableCents,
  refundedCentsOf,
  type Row,
  transactionUrlForSeller,
} from "./customers.ts";

const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];
const ALL_SUCCESS_STATES_EXCEPT_PREORDER_AUTH_AND_GIFT = ["successful", "not_charged"];
const SEND_EMAILS_FLAG = 256;
const SINGLE_RECIPIENT_EMAIL_FLAG = 2048;
const CHARGEBACK_REVERSED_FLAG = 512;
const PAYPAL_REFUND_WINDOW_MONTHS = 6;

const list = (values: unknown[]) => Prisma.join(values as (bigint | number | string)[]);
const flag = (purchase: Row, name: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(purchase.flags, name);
const truthy = (value: unknown) => value === true || value === 1 || value === 1n;
const secondsOf = (date: Date) => Math.floor(date.getTime() / 1000);
const pad = (value: number, width = 2) => String(value).padStart(width, "0");

async function rows(statement: Prisma.Sql): Promise<Row[]> {
  return selectRows<Row>(statement);
}

// `current_seller.sales.find_by_external_id!`
export async function findSellerSale(sellerId: bigint, externalId: string): Promise<Row> {
  const id = decrypt(externalId);
  const [sale] =
    id === null
      ? []
      : await rows(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "id")} = ${BigInt(id)} LIMIT 1`,
        );
  if (!sale) throw new RoutingError("Not Found");
  return sale;
}

// `Purchase.where(email: params[:purchase_email].to_s).find_by_external_id!`: any seller's sale, as long as the email matches.
export async function findSaleByEmail(email: string, externalId: string): Promise<Row> {
  const id = decrypt(externalId);
  const [sale] =
    id === null
      ? []
      : await rows(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "email")} = ${email} AND ${column("purchases", "id")} = ${BigInt(id)} LIMIT 1`,
        );
  if (!sale) throw new RoutingError("Not Found");
  return sale;
}

// `6.months.ago`: the same day of the month six months back, clamped to the end of a shorter month.
export function sixMonthsAgo(now: Date): Date {
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth() - PAYPAL_REFUND_WINDOW_MONTHS;
  const year = Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

// CustomerPresenter#charge
async function chargeJson(purchase: Row, refundedCents: number, now: Date) {
  assertRefundableReadable(purchase);
  const [merchantAccount] =
    purchase.merchant_account_id == null
      ? []
      : await rows(
          Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} = ${purchase.merchant_account_id} LIMIT 1`,
        );
  const refunded = truthy(purchase.stripe_refunded);
  return {
    id: encrypt(purchase.id),
    created_at: purchase.created_at.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    partially_refunded: truthy(purchase.stripe_partially_refunded),
    refunded,
    amount_refundable: await refundableCents(purchase, refundedCents, String(purchase.displayed_price_currency_type)),
    currency_type: String(purchase.displayed_price_currency_type),
    transaction_url_for_seller: transactionUrlForSeller(purchase, merchantAccount ?? null),
    is_upgrade_purchase: flag(purchase, "is_upgrade_purchase"),
    chargedback: purchase.chargeback_date != null && !flag(purchase, "chargeback_reversed") && !refunded,
    paypal_refund_expired:
      purchase.card_type === "paypal" && secondsOf(purchase.created_at) < secondsOf(sixMonthsAgo(now)),
  };
}

// CustomersController#build_charges
export async function buildCharges(purchase: Row, now = new Date()) {
  let sales: Row[];
  if (flag(purchase, "is_original_subscription_purchase")) {
    if (purchase.subscription_id == null)
      throw new HandBackToRails("an original subscription purchase without a subscription");
    sales = await rows(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${purchase.subscription_id} AND ${column("purchases", "purchase_state")} = 'successful' ORDER BY ${column("purchases", "id")} ASC`,
    );
  } else if (flag(purchase, "is_commission_deposit_purchase")) {
    const [completion] = await rows(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("commissions")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("commissions", "completion_purchase_id")} WHERE ${column("commissions", "deposit_purchase_id")} = ${purchase.id} LIMIT 1`,
    );
    sales = completion ? [purchase, completion] : [purchase];
  } else {
    return [];
  }
  const refunded = await refundedCentsOf(sales.map((sale) => sale.id));
  return Promise.all(sales.map((sale) => chargeJson(sale, refunded.get(String(sale.id)) ?? 0, now)));
}

// `purchase.product_purchases`: the purchases a bundle purchase delivered, in the order the join rows were made.
export async function bundleProductPurchaseIds(purchase: Row): Promise<string[]> {
  const found = await rows(
    Prisma.sql`SELECT ${column("bundle_product_purchases", "product_purchase_id")} FROM ${table("bundle_product_purchases")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("bundle_product_purchases", "product_purchase_id")} WHERE ${column("bundle_product_purchases", "bundle_purchase_id")} = ${purchase.id} ORDER BY ${column("bundle_product_purchases", "id")} ASC`,
  );
  return found.map((row) => String(row.product_purchase_id));
}

// ActiveSupport::TimeWithZone#as_json: `xmlschema(3)`.
export function railsJsonTime(zone: string, instant: Date): string {
  const iso = instantInTimeZoneIso8601(zone, instant);
  const milliseconds = `.${pad(instant.getUTCMilliseconds(), 3)}`;
  return iso.endsWith("Z")
    ? `${iso.slice(0, -1)}${milliseconds}Z`
    : `${iso.slice(0, -6)}${milliseconds}${iso.slice(-6)}`;
}

export const humanize = (value: string) => {
  const text = value.replace(/_id$/u, "").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// EmailInfo#most_recent_state_at
const mostRecentStateAt = (info: Row): Date | null => info.opened_at ?? info.delivered_at ?? info.sent_at ?? null;

type Email = {
  type: string;
  name: string;
  id: string;
  state: string;
  state_at: string;
  url?: string;
  date: Date | null;
};

// CustomersController#build_customer_emails
export async function buildCustomerEmails(
  seller: User,
  original: Row,
  receiptHost: { protocol: string; host: string },
) {
  const zone = seller.timezone;
  let allPurchases: Row[];
  if (original.subscription_id == null) allPurchases = [original];
  else {
    allPurchases = await rows(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${original.subscription_id} AND ${column("purchases", "purchase_state")} IN (${list(ALL_SUCCESS_STATES_EXCEPT_PREORDER_AUTH_AND_GIFT)}) ORDER BY ${column("purchases", "id")} ASC`,
    );
  }
  // `uses_charge_receipt?` is true for a purchase on a Charge that belongs to an Order, and the receipt then comes off the Charge
  // (its `email_info_charges`, or one receipt per purchase of a two-item charge). A purchase on an Order without a Charge, or on no
  // order, reads its own email infos. Only a charge with no receipt record of its own and no second item is read here.
  const purchaseIds = list(allPurchases.map((purchase) => purchase.id));
  const charged = await rows(
    Prisma.sql`SELECT ${column("charges", "id")}, ${column("charge_purchases", "purchase_id")} FROM ${table("charge_purchases")} INNER JOIN ${table("charges")} ON ${column("charges", "id")} = ${column("charge_purchases", "charge_id")} INNER JOIN ${table("orders")} ON ${column("orders", "id")} = ${column("charges", "order_id")} WHERE ${column("charge_purchases", "purchase_id")} IN (${purchaseIds})`,
  );
  for (const charge of charged) {
    const [infoCharge] = await rows(
      Prisma.sql`SELECT ${column("email_info_charges", "id")} FROM ${table("email_info_charges")} WHERE ${column("email_info_charges", "charge_id")} = ${charge.id} LIMIT 1`,
    );
    if (infoCharge) throw new HandBackToRails("a receipt sent through a charge");
    const chargeItems = await rows(
      Prisma.sql`SELECT ${column("charge_purchases", "purchase_id")} FROM ${table("charge_purchases")} WHERE ${column("charge_purchases", "charge_id")} = ${charge.id}`,
    );
    if (chargeItems.length >= 2) throw new HandBackToRails("a charge with more than one item");
  }
  // `charge.receipt_email_infos` is empty, so these purchases take the receipt's defaults whatever email infos they hold themselves.
  const throughCharge = new Set(charged.map((row) => String(row.purchase_id)));
  const receiptInfos = await rows(
    Prisma.sql`SELECT ${Prisma.raw("`email_infos`.*")} FROM ${table("email_infos")} WHERE ${column("email_infos", "type")} = 'CustomerEmailInfo' AND ${column("email_infos", "purchase_id")} IN (${list(allPurchases.map((purchase) => purchase.id))}) ORDER BY ${column("email_infos", "id")} DESC`,
  );
  const latestReceipt = new Map<string, Row>();
  for (const info of receiptInfos)
    if (!latestReceipt.has(String(info.purchase_id))) latestReceipt.set(String(info.purchase_id), info);

  const receipts: Email[] = allPurchases.map((purchase) => {
    const info = throughCharge.has(String(purchase.id)) ? undefined : latestReceipt.get(String(purchase.id));
    const stateAt = info ? mostRecentStateAt(info) : purchase.created_at;
    if (stateAt === null) throw new HandBackToRails("a receipt email info without a timestamp");
    return {
      type: "receipt",
      name: info?.email_name ? humanize(info.email_name) : "Receipt",
      id: encrypt(purchase.id),
      state: info?.state ? humanize(info.state) : "Delivered",
      state_at: railsJsonTime(zone, stateAt),
      url: `${receiptHost.protocol}://${receiptHost.host}/purchases/${encrypt(purchase.id)}/receipt?email=${cgiEscape(purchase.email ?? "")}`,
      date: purchase.created_at,
    };
  });

  const installments = await rows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} INNER JOIN ${table("email_infos")} ON ${column("installments", "id")} = ${column("email_infos", "installment_id")} WHERE ${column("email_infos", "purchase_id")} = ${original.id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "seller_id")} = ${original.seller_id} ORDER BY ${column("email_infos", "id")} ASC`,
  );
  // `has_many :installments, through: :email_infos` does not de-duplicate.
  const unique = [...new Map(installments.map((installment) => [String(installment.id), installment])).values()];
  const infos =
    unique.length === 0
      ? []
      : await rows(
          Prisma.sql`SELECT ${Prisma.raw("`email_infos`.*")} FROM ${table("email_infos")} WHERE ${column("email_infos", "type")} = 'CreatorContactingCustomersEmailInfo' AND ${column("email_infos", "purchase_id")} = ${original.id} AND ${column("email_infos", "installment_id")} IN (${list(unique.map((installment) => installment.id))}) ORDER BY ${column("email_infos", "id")} ASC`,
        );
  const infoByInstallment = new Map<string, Row>();
  for (const info of infos) infoByInstallment.set(String(info.installment_id), info);

  const posts: Email[] = installments.map((post) => {
    const info = infoByInstallment.get(String(post.id));
    const stateAt = info ? mostRecentStateAt(info) : null;
    if (!info?.state || stateAt === null) throw new HandBackToRails("a post whose email info is missing");
    return {
      type: "post",
      name: post.name,
      id: encrypt(post.id),
      state: humanize(info.state),
      state_at: railsJsonTime(zone, stateAt),
      date: post.published_at,
    };
  });
  const unpublished = posts.filter((post) => post.date === null);
  const published = posts.filter((post) => post.date !== null);
  const seconds = published.map((post) => secondsOf(post.date!));
  // Array#sort_by is not stable: posts published in the same second come out in an order only Ruby knows.
  if (new Set(seconds).size !== seconds.length) throw new HandBackToRails("posts published in the same second");
  const sorted = [...published].sort((a, b) => secondsOf(b.date!) - secondsOf(a.date!));
  const emails = [...sorted, ...unpublished];
  const body = flag(original, "is_bundle_product_purchase") ? emails : [...receipts, ...emails];
  return body.map((email) => ({ ...email, date: email.date === null ? null : railsJsonTime("UTC", email.date) }));
}

// Installment.missed_for_purchase + CustomerPresenter#missed_posts
export async function missedPosts(purchase: Row) {
  if (!truthy(purchase.can_contact)) return [];
  if (purchase.link_id == null) throw new HandBackToRails("a sale without a product");
  const candidates = await rows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${purchase.seller_id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "flags")} & ${SINGLE_RECIPIENT_EMAIL_FLAG} = 0 AND ${column("installments", "flags")} & ${SEND_EMAILS_FLAG} > 0 ORDER BY ${column("installments", "id")} ASC`,
  );
  if (candidates.length === 0) return [];

  const record = new PurchaseRecord(castRow<Purchase>("Purchase", purchase), null);
  const passing: Row[] = [];
  for (const candidate of candidates) {
    const post = new InstallmentPost(castRow<Installment>("Installment", candidate));
    if (await purchasePassesFilters(post, record)) passing.push(candidate);
  }
  if (passing.length === 0) return [];
  const [seller] = await rows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${purchase.seller_id} LIMIT 1`,
  );
  if (!seller) throw new HandBackToRails("a sale whose seller is missing");

  const sameEmail = await rows(
    Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "email")} = ${purchase.email} AND ${column("purchases", "seller_id")} = ${purchase.seller_id} AND ${column("purchases", "purchase_state")} IN (${list(ALL_SUCCESS_STATES)}) AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) AND (${column("purchases", "chargeback_date")} IS NULL OR (${column("purchases", "chargeback_date")} IS NOT NULL AND ${column("purchases", "flags")} & ${CHARGEBACK_REVERSED_FLAG} != 0))`,
  );
  const purchaseIds = [...sameEmail.map((row) => row.id), purchase.id];
  const sent = await rows(
    Prisma.sql`SELECT DISTINCT ${column("email_infos", "installment_id")} FROM ${table("email_infos")} WHERE ${column("email_infos", "installment_id")} IN (${list(passing.map((post) => post.id))}) AND ${column("email_infos", "purchase_id")} IN (${list(purchaseIds)})`,
  );
  const sentIds = new Set(sent.map((row) => String(row.installment_id)));
  return passing
    .filter((post) => !sentIds.has(String(post.id)))
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime() || num(a.id) - num(b.id))
    .map((post) => ({
      id: encrypt(post.id),
      name: post.name,
      url: fullUrl(castRow<User>("User", seller), castRow<Installment>("Installment", post)),
      published_at: railsJsonTime("UTC", post.published_at),
    }));
}
