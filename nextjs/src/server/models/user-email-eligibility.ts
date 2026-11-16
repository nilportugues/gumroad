// What decides whether a seller may email their audience (app/models/user.rb): `email_sending_override_active?`,
// `qualifies_as_email_sending_override_parent?`, `has_completed_payouts?` and `eligible_to_send_emails?`.
// Golden: worker/jobs/__fixtures__/publish-scheduled-post.golden.json (the override cases) and
// workflow-writes.golden.json (the eligibility cases).
import { Prisma, type User } from "@prisma/client";

import { salesCentsTotal } from "../search/purchase-sales.ts";
import { findOneBy } from "./row-reads.ts";
import { column, columnIn, selectRows, table } from "./sql.ts";
import { castBoolean } from "./with-filtering.ts";
import { isFlagged, isFlagSet, isSuspended, jsonDataForAttr, Users } from "./user.ts";

// Installment::MINIMUM_SALES_CENTS_VALUE
export const MINIMUM_SALES_CENTS_VALUE = 100_00;

const exists = async (statement: Prisma.Sql): Promise<boolean> => (await selectRows(statement)).length > 0;

// `payments.completed.exists?`
const hasCompletedPayment = (userId: bigint | number) =>
  exists(Prisma.sql`SELECT 1 AS one FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${userId} AND ${column("payments", "state")} = ${"completed"} LIMIT 1`);

// `seller_memberships.not_deleted.role_admin.exists?(user_id:)`
const administeredBy = (sellerId: bigint | number, parentId: bigint | number) =>
  exists(
    Prisma.sql`SELECT 1 AS one FROM ${table("team_memberships")} WHERE ${column("team_memberships", "seller_id")} = ${sellerId} AND ${column("team_memberships", "deleted_at")} IS NULL AND ${column("team_memberships", "role")} = ${"admin"} AND ${column("team_memberships", "user_id")} = ${parentId} LIMIT 1`,
  );

// `qualifies_as_email_sending_override_parent?`
async function qualifiesAsOverrideParent(parent: User): Promise<boolean> {
  const record = Users.load(parent);
  if (record.get("deleted_at") !== null) return false;
  if (!parent.verified) return false;
  if (isFlagged(record) || isSuspended(record)) return false;
  return hasCompletedPayment(parent.id);
}

// `email_sending_override_active?`: the parent is re-checked on every call.
export async function emailSendingOverrideActive(user: User): Promise<boolean> {
  const record = Users.load(user);
  if (!(castBoolean(jsonDataForAttr(record, "email_sending_override", false)) ?? false)) return false;
  if (isSuspended(record) || isFlagged(record)) return false;

  const parentId = jsonDataForAttr(record, "email_sending_override_parent_id");
  const key = parentId === null ? null : typeof parentId === "number" || typeof parentId === "bigint" || typeof parentId === "string" ? parentId : null;
  const parent = await findOneBy<User>("User", "id", key as bigint | number | string | null, true);
  if (parent === null) return false;
  return (await administeredBy(user.id, parent.id)) && (await qualifiesAsOverrideParent(parent));
}

// `has_completed_payouts?`: a completed payout, or a sale through a Connect account.
async function hasCompletedPayouts(user: User): Promise<boolean> {
  return (await hasCompletedPayment(user.id)) || (await madeSaleWithConnectOrPaypalAccount(user.id));
}

// flag_shih_tzu bits of purchases.flags: is_gift_receiver_purchase is flag 6, chargeback_reversed flag 10.
const GIFT_RECEIVER_PURCHASE_FLAG = 2 ** 5;
const CHARGEBACK_REVERSED_FLAG = 2 ** 9;

// `made_a_successful_sale_with_a_stripe_connect_or_paypal_connect_account?`
async function madeSaleWithConnectOrPaypalAccount(userId: bigint | number): Promise<boolean> {
  const accounts = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "id")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND (${column("merchant_accounts", "charge_processor_id")} = 'stripe' AND (json_data->>'$.meta.stripe_connect' = 'true') AND ${column("merchant_accounts", "user_id")} IS NOT NULL OR ${column("merchant_accounts", "charge_processor_id")} = 'paypal')`,
  );
  if (accounts.length === 0) return false;
  const purchases = (name: string) => column("purchases", name);
  // The text ActiveRecord writes for `sales.successful_or_preorder_authorization_successful_and_not_refunded_or_chargedback.where(merchant_account_id: ids)`
  return exists(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${purchases("seller_id")} = ${userId} AND ${purchases("purchase_state")} IN ('successful', 'preorder_authorization_successful', 'gift_receiver_purchase_successful') AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '${Prisma.raw(String(CHARGEBACK_REVERSED_FLAG))}' != 0)) AND ((${purchases("flags")} & ${Prisma.raw(String(GIFT_RECEIVER_PURCHASE_FLAG))} = 0)) AND ${columnIn("purchases", "merchant_account_id", accounts.map((account) => account.id))} LIMIT 1`,
  );
}

// `eligible_for_abandoned_cart_workflows?`
export async function eligibleForAbandonedCartWorkflows(user: User): Promise<boolean> {
  const record = Users.load(user);
  if (isFlagSet(record, "is_team_member")) return true;
  if (isSuspended(record)) return false;
  return hasCompletedPayouts(user);
}

// `eligible_to_send_emails?`
export async function eligibleToSendEmails(user: User): Promise<boolean> {
  const record = Users.load(user);
  if (isFlagSet(record, "is_team_member")) return true;
  if (isSuspended(record)) return false;
  if (await emailSendingOverrideActive(user)) return true;
  if ((await salesCentsTotal(user.id)) < MINIMUM_SALES_CENTS_VALUE) return false;
  // Verified sellers may email before their first payout completes, unless the account is flagged.
  return (Boolean(user.verified) && !isFlagged(record)) || (await hasCompletedPayouts(user));
}
