// The reads behind the signed-in shared props, as plain existence checks and lookups against the
// tables Rails reads. Nothing here writes.
import { Prisma, type User } from "@prisma/client";

import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../models/merchant-account.ts";
import { column, execute, selectRows, table } from "../../models/sql.ts";

// flag_shih_tzu stores flag n as 2**(n - 1).
const COMMUNITY_CHAT_ENABLED_FLAG = 2 ** 29;

const exists = async (sql: Prisma.Sql): Promise<boolean> => (await selectRows(sql)).length > 0;

// `user.products.alive.exists?`: Link.alive is purchase_disabled_at, banned_at and deleted_at all nil.
export const hasAliveProducts = (sellerId: bigint) =>
  exists(Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL LIMIT 1`);

// `user.is_buyer?`: `!links.exists? && purchases.successful.exists?`
export async function isBuyer(userId: bigint): Promise<boolean> {
  if (await exists(Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${userId} LIMIT 1`)) return false;
  return exists(Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${userId} AND ${column("purchases", "purchase_state")} = 'successful' LIMIT 1`);
}

// `user.webauthn_credentials.none?`
export async function passkeysSetupPending(userId: bigint): Promise<boolean> {
  return !(await exists(Prisma.sql`SELECT 1 FROM ${table("webauthn_credentials")} WHERE ${column("webauthn_credentials", "user_id")} = ${userId} LIMIT 1`));
}

// `user.bank_accounts.alive.first`
export async function activeBankAccount(userId: bigint): Promise<{ type: string | null } | null> {
  const [row] = await selectRows<{ type: string | null }>(
    Prisma.sql`SELECT ${column("bank_accounts", "type")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC LIMIT 1`,
  );
  return row ?? null;
}

export type ComplianceInfoRow = {
  country: string | null;
  business_country: string | null;
  is_business: number | boolean | null;
  birthday: Date | null;
};

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
export async function aliveComplianceInfo(userId: bigint): Promise<ComplianceInfoRow | null> {
  const [row] = await selectRows<ComplianceInfoRow>(
    Prisma.sql`SELECT ${column("user_compliance_info", "country")}, ${column("user_compliance_info", "business_country")}, ${column("user_compliance_info", "is_business")}, ${column("user_compliance_info", "birthday")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "user_id")} = ${userId} AND ${column("user_compliance_info", "deleted_at")} IS NULL ORDER BY ${column("user_compliance_info", "id")} DESC LIMIT 1`,
  );
  return row ?? null;
}

// `stripe_account.present? || stripe_connect_account.present? || paypal_connect_account.present?`
export async function hasPayoutAccount(userId: bigint): Promise<boolean> {
  const stripeAccounts = await aliveStripeAccountsOf(userId);
  if (stripeAccounts.some((account) => !isStripeConnectAccount(account))) return true;
  if (stripeAccounts.some(isStripeConnectAccount)) return true;
  // PayPal merchant accounts always accept charges, so alive and charge-processor-alive is enough.
  return exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = 'paypal' LIMIT 1`,
  );
}

// `user.payments.completed.exists?`
export const hasCompletedPayment = (userId: bigint) =>
  exists(Prisma.sql`SELECT 1 FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${userId} AND ${column("payments", "state")} = 'completed' LIMIT 1`);

// The first half of `merchant_accounts.stripe_connect.or(merchant_accounts.paypal).pluck(:id)`: whether
// User#made_a_successful_sale_with_a_stripe_connect_or_paypal_connect_account? has anything to look at.
export const hasConnectOrPaypalMerchantAccount = (userId: bigint) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND (${column("merchant_accounts", "charge_processor_id")} = 'paypal' OR (${column("merchant_accounts", "charge_processor_id")} = 'stripe' AND JSON_UNQUOTE(JSON_EXTRACT(${column("merchant_accounts", "json_data")}, '$.meta.stripe_connect')) = 'true')) LIMIT 1`,
  );

// A candidate for User#latest_payout_setup_rejection_note: the alive payout notes the admin wrote that
// mention the rejection marker. Rails then checks the marker in the parsed json_data; any candidate
// is enough for us to refuse (see the presenter).
export const hasPayoutSetupRejectionCandidate = (userId: bigint, adminId: number) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("comments")} WHERE ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "commentable_id")} = ${userId} AND ${column("comments", "comment_type")} = 'payout_note' AND ${column("comments", "deleted_at")} IS NULL AND ${column("comments", "author_id")} = ${adminId} AND ${column("comments", "json_data")} LIKE '%payout_setup_rejection%' LIMIT 1`,
  );

// `dashboard_nav_promotions.pluck(:nav_item)`. Rails sets no order, so MySQL answers from the unique
// (user_id, nav_item) index, which is by nav_item.
export async function dashboardNavItems(userId: bigint): Promise<string[]> {
  const rows = await selectRows<{ nav_item: string }>(
    Prisma.sql`SELECT ${column("dashboard_nav_promotions", "nav_item")} FROM ${table("dashboard_nav_promotions")} WHERE ${column("dashboard_nav_promotions", "user_id")} = ${userId} ORDER BY ${column("dashboard_nav_promotions", "nav_item")} ASC`,
  );
  return rows.map((row) => row.nav_item);
}

// `user.avatar.attached?`
export const hasAvatarAttachment = (userId: bigint) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_type")} = 'User' AND ${column("active_storage_attachments", "record_id")} = ${userId} AND ${column("active_storage_attachments", "name")} = 'avatar' LIMIT 1`,
  );

// User#has_accessible_communities?
export async function hasAccessibleCommunities(user: Pick<User, "id" | "email">): Promise<boolean> {
  // Community.with_chat_enabled_product: Link.alive plus the community_chat_enabled flag (position 30).
  const chatEnabledProducts = Prisma.sql`INNER JOIN ${table("links")} ON ${column("communities", "resource_type")} = 'Link' AND ${column("communities", "resource_id")} = ${column("links", "id")} AND ${column("communities", "deleted_at")} IS NULL AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "flags")} & ${COMMUNITY_CHAT_ENABLED_FLAG} > 0`;
  if (await exists(Prisma.sql`SELECT 1 FROM ${table("communities")} ${chatEnabledProducts} WHERE ${column("communities", "seller_id")} = ${user.id} LIMIT 1`)) return true;

  const purchased = Prisma.sql`SELECT 1 FROM ${table("communities")} ${chatEnabledProducts} INNER JOIN ${table("purchases")} ON ${column("purchases", "link_id")} = ${column("links", "id")} WHERE ${column("purchases", "purchase_state")} = 'successful'`;
  if (await exists(Prisma.sql`${purchased} AND ${column("purchases", "purchaser_id")} = ${user.id} LIMIT 1`)) return true;
  if (user.email === null) return false;
  return exists(Prisma.sql`${purchased} AND ${column("purchases", "email")} = ${user.email} AND (${column("purchases", "purchaser_id")} IS NULL OR ${column("purchases", "purchaser_id")} != ${user.id}) LIMIT 1`);
}

// DashboardNav.earned_items, in its own order.
export async function earnedNavItems(user: Pick<User, "id">, sellerId: bigint): Promise<string[]> {
  const items: string[] = [];
  const has = (tableName: string, where: Prisma.Sql) => exists(Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${where} LIMIT 1`);
  const col = column;

  if (await hasAliveProducts(sellerId)) items.push("profile");
  if (await has("pages", Prisma.sql`${col("pages", "pageable_type")} = 'User' AND ${col("pages", "pageable_id")} = ${sellerId} AND ${col("pages", "slug")} IS NOT NULL`)) items.push("pages");
  if (await has("affiliates", Prisma.sql`${col("affiliates", "seller_id")} = ${sellerId} AND ${col("affiliates", "type")} = 'Collaborator'`)) items.push("collaborators");
  if (
    (await has("offer_codes", Prisma.sql`${col("offer_codes", "user_id")} = ${sellerId}`)) ||
    (await has("upsells", Prisma.sql`${col("upsells", "seller_id")} = ${sellerId}`)) ||
    (await has("custom_fields", Prisma.sql`${col("custom_fields", "seller_id")} = ${sellerId}`))
  ) {
    items.push("checkout");
  }
  if (
    (await has("installments", Prisma.sql`${col("installments", "seller_id")} = ${sellerId}`)) ||
    (await has("followers", Prisma.sql`${col("followers", "followed_id")} = ${sellerId} AND ${col("followers", "deleted_at")} IS NULL AND ${col("followers", "confirmed_at")} IS NOT NULL`))
  ) {
    items.push("emails");
  }
  if (await has("workflows", Prisma.sql`${col("workflows", "seller_id")} = ${sellerId}`)) items.push("workflows");
  if (await has("purchases", Prisma.sql`${col("purchases", "seller_id")} = ${sellerId}`)) items.push("analytics");
  if (
    (await has("affiliates", Prisma.sql`${col("affiliates", "seller_id")} = ${sellerId} AND ${col("affiliates", "type")} = 'DirectAffiliate' AND ${col("affiliates", "deleted_at")} IS NULL`)) ||
    (await has("affiliate_requests", Prisma.sql`${col("affiliate_requests", "seller_id")} = ${sellerId}`))
  ) {
    items.push("affiliates");
  }
  if (await has("communities", Prisma.sql`${col("communities", "seller_id")} = ${sellerId} AND ${col("communities", "deleted_at")} IS NULL`)) items.push("community");
  if (await has("ai_conversations", Prisma.sql`${col("ai_conversations", "seller_id")} = ${sellerId}`)) items.push("agent");
  if (await has("purchases", Prisma.sql`${col("purchases", "purchaser_id")} = ${user.id}`)) items.push("library");
  return items;
}

// DashboardNavPromotion.insert_all: rows already held by the unique index are skipped, and Rails
// leaves the timestamps to the database clock (CURRENT_TIMESTAMP(6)).
export async function insertNavItems(userId: bigint, items: string[]): Promise<void> {
  if (items.length === 0) return;
  const rows = Prisma.join(items.map((item) => Prisma.sql`(${userId}, ${item}, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))`));
  await execute(Prisma.sql`INSERT IGNORE INTO ${table("dashboard_nav_promotions")} (${column("dashboard_nav_promotions", "user_id")}, ${column("dashboard_nav_promotions", "nav_item")}, ${column("dashboard_nav_promotions", "created_at")}, ${column("dashboard_nav_promotions", "updated_at")}) VALUES ${rows}`);
}
