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
  guardian_id: bigint | null;
};

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
export async function aliveComplianceInfo(userId: bigint): Promise<ComplianceInfoRow | null> {
  const [row] = await selectRows<ComplianceInfoRow>(
    Prisma.sql`SELECT ${column("user_compliance_info", "country")}, ${column("user_compliance_info", "business_country")}, ${column("user_compliance_info", "is_business")}, ${column("user_compliance_info", "birthday")}, ${column("user_compliance_info", "guardian_id")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "user_id")} = ${userId} AND ${column("user_compliance_info", "deleted_at")} IS NULL ORDER BY ${column("user_compliance_info", "id")} DESC LIMIT 1`,
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

// flag_shih_tzu bits of purchases.flags: is_gift_receiver_purchase is flag 6, chargeback_reversed flag 10.
const GIFT_RECEIVER_PURCHASE_FLAG = 2 ** 5;
const CHARGEBACK_REVERSED_FLAG = 2 ** 9;

// User#made_a_successful_sale_with_a_stripe_connect_or_paypal_connect_account?: the ids of
// `merchant_accounts.stripe_connect.or(merchant_accounts.paypal)`, then a sale through one of them
// that is neither refunded in full nor an unreversed chargeback.
export async function madeSaleWithConnectOrPaypalAccount(userId: bigint): Promise<boolean> {
  const accounts = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "id")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ((${column("merchant_accounts", "charge_processor_id")} = 'stripe' AND json_data->>'$.meta.stripe_connect' = 'true' AND ${column("merchant_accounts", "user_id")} IS NOT NULL) OR ${column("merchant_accounts", "charge_processor_id")} = 'paypal')`,
  );
  if (accounts.length === 0) return false;
  const purchases = (name: string) => column("purchases", name);
  return exists(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${purchases("seller_id")} = ${userId} AND ${purchases("purchase_state")} IN ('successful', 'preorder_authorization_successful', 'gift_receiver_purchase_successful') AND (${purchases("stripe_refunded")} IS NULL OR ${purchases("stripe_refunded")} = 0) AND (${purchases("chargeback_date")} IS NULL OR (${purchases("chargeback_date")} IS NOT NULL AND ${purchases("flags")} & ${CHARGEBACK_REVERSED_FLAG} != 0)) AND ${purchases("flags")} & ${GIFT_RECEIVER_PURCHASE_FLAG} = 0 AND ${purchases("merchant_account_id")} IN (${Prisma.join(accounts.map((account) => account.id))}) LIMIT 1`,
  );
}

// The Guardian columns Guardian#has_completed_info? reads. individual_tax_id is Strongbox ciphertext;
// only whether it is blank matters.
export type GuardianRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  date_of_birth: Date | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  country_code: string | null;
  individual_tax_id: Uint8Array | null;
  stripe_tos_accepted: number | boolean;
  stripe_tos_accepted_at: Date | null;
  stripe_tos_ip: string | null;
  deleted_at: Date | null;
};

// `belongs_to :guardian` on the compliance info: the row by id, deleted or not.
export async function guardianById(id: bigint): Promise<GuardianRow | null> {
  const guardians = (name: string) => column("guardians", name);
  const [row] = await selectRows<GuardianRow>(
    Prisma.sql`SELECT ${guardians("first_name")}, ${guardians("last_name")}, ${guardians("email")}, ${guardians("date_of_birth")}, ${guardians("street_address")}, ${guardians("city")}, ${guardians("state")}, ${guardians("zip_code")}, ${guardians("country")}, ${guardians("country_code")}, ${guardians("individual_tax_id")}, ${guardians("stripe_tos_accepted")}, ${guardians("stripe_tos_accepted_at")}, ${guardians("stripe_tos_ip")}, ${guardians("deleted_at")} FROM ${table("guardians")} WHERE ${guardians("id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// User#latest_payout_setup_rejection_note.present?: the alive payout notes the admin wrote that
// mention the rejection marker, newest first, and the first whose parsed json_data carries the
// marker as true. JsonData#json_data raises for a value that is not a hash, and the JSON coder for
// text that is not JSON; both are errors here too.
export async function hasPayoutSetupRejectionNote(userId: bigint, adminId: number): Promise<boolean> {
  const notes = await selectRows<{ json_data: string | null }>(
    Prisma.sql`SELECT ${column("comments", "json_data")} FROM ${table("comments")} WHERE ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "commentable_id")} = ${userId} AND ${column("comments", "comment_type")} = 'payout_note' AND ${column("comments", "deleted_at")} IS NULL AND ${column("comments", "author_id")} = ${adminId} AND ${column("comments", "json_data")} LIKE '%payout_setup_rejection%' ORDER BY ${column("comments", "created_at")} DESC, ${column("comments", "id")} DESC`,
  );
  return notes.some((note) => {
    const parsed: unknown = note.json_data === null || note.json_data === "" ? {} : JSON.parse(note.json_data);
    if (parsed === null || parsed === false) return false;
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("json_data must be a hash");
    return (parsed as Record<string, unknown>).payout_setup_rejection === true;
  });
}

// `dashboard_nav_promotions.pluck(:nav_item)`. Rails sets no order, so MySQL answers from the unique
// (user_id, nav_item) index, which is by nav_item.
export async function dashboardNavItems(userId: bigint): Promise<string[]> {
  const rows = await selectRows<{ nav_item: string }>(
    Prisma.sql`SELECT ${column("dashboard_nav_promotions", "nav_item")} FROM ${table("dashboard_nav_promotions")} WHERE ${column("dashboard_nav_promotions", "user_id")} = ${userId} ORDER BY ${column("dashboard_nav_promotions", "nav_item")} ASC`,
  );
  return rows.map((row) => row.nav_item);
}

// `user.avatar_attachment`: `user.avatar.attached?` is whether it exists.
export async function avatarAttachmentOf(userId: bigint): Promise<{ id: bigint; blob_id: bigint } | null> {
  const attachments = (name: string) => column("active_storage_attachments", name);
  const [row] = await selectRows<{ id: bigint; blob_id: bigint }>(
    Prisma.sql`SELECT ${attachments("id")}, ${attachments("blob_id")} FROM ${table("active_storage_attachments")} WHERE ${attachments("record_type")} = 'User' AND ${attachments("record_id")} = ${userId} AND ${attachments("name")} = 'avatar' LIMIT 1`,
  );
  return row ?? null;
}

// `record.<name>` of a has_one_attached, or (ordered by attachment id) the has_many_attached `record.<name>`.
export async function attachmentsOf(recordType: string, recordId: bigint, name: string): Promise<{ id: bigint; blob_id: bigint }[]> {
  const attachments = (column_: string) => column("active_storage_attachments", column_);
  return selectRows<{ id: bigint; blob_id: bigint }>(
    Prisma.sql`SELECT ${attachments("id")}, ${attachments("blob_id")} FROM ${table("active_storage_attachments")} WHERE ${attachments("record_type")} = ${recordType} AND ${attachments("record_id")} = ${recordId} AND ${attachments("name")} = ${name} ORDER BY ${attachments("id")} ASC`,
  );
}

export type BlobRow = { id: bigint; key: string; filename: string; content_type: string | null; service_name: string };

export async function blobById(id: bigint): Promise<BlobRow | null> {
  const blobs = (name: string) => column("active_storage_blobs", name);
  const [row] = await selectRows<BlobRow>(
    Prisma.sql`SELECT ${blobs("id")}, ${blobs("key")}, ${blobs("filename")}, ${blobs("content_type")}, ${blobs("service_name")} FROM ${table("active_storage_blobs")} WHERE ${blobs("id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `blob.variant_records.find_by(variation_digest:)`
export async function variantRecordId(blobId: bigint, variationDigest: string): Promise<bigint | null> {
  const records = (name: string) => column("active_storage_variant_records", name);
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${records("id")} FROM ${table("active_storage_variant_records")} WHERE ${records("blob_id")} = ${blobId} AND ${records("variation_digest")} = ${variationDigest} LIMIT 1`,
  );
  return row?.id ?? null;
}

// `variant_record.image.blob.key`: the variant's file, attached to its record as `image`.
export async function variantBlobKey(variantRecordId: bigint): Promise<string | null> {
  const [row] = await selectRows<{ key: string }>(
    Prisma.sql`SELECT ${column("active_storage_blobs", "key")} FROM ${table("active_storage_attachments")} INNER JOIN ${table("active_storage_blobs")} ON ${column("active_storage_blobs", "id")} = ${column("active_storage_attachments", "blob_id")} WHERE ${column("active_storage_attachments", "record_type")} = 'ActiveStorage::VariantRecord' AND ${column("active_storage_attachments", "record_id")} = ${variantRecordId} AND ${column("active_storage_attachments", "name")} = 'image' LIMIT 1`,
  );
  return row?.key ?? null;
}

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
