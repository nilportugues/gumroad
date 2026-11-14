// ApplicationController#check_payment_details: a seller Stripe has asked for more information is sent to
// the payments settings; the Stripe call that clears the flag is Rails'.
import { Prisma } from "@prisma/client";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { getRedis } from "../../infra/redis.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import type { SellerContext } from "../../policies/seller-context.ts";

// RedisKey.user_ids_with_payment_requirements_key
export const PAYMENT_REQUIREMENTS_KEY = "user_ids_with_payment_requirements_key";

// `$redis.sismember`, degraded to "no requirements" when Redis fails (seller_has_payment_requirements?).
async function sellerHasPaymentRequirements(sellerId: bigint | number): Promise<boolean> {
  try {
    return (await getRedis("main").sismember(PAYMENT_REQUIREMENTS_KEY, String(sellerId))) === 1;
  } catch {
    return false;
  }
}

const exists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;

// Returns when Rails would carry on to the action. Throws HandBackToRails when Rails would redirect to
// the payments settings (a requested compliance info request: a flash that keeps the session's own) or
// call `Stripe::Account.retrieve` to decide: Node makes no Stripe calls here, and the answer is Stripe's.
export async function checkPaymentDetails(context: SellerContext): Promise<void> {
  const seller = context.seller;
  if (!seller) return;
  if (!(await sellerHasPaymentRequirements(seller.id))) return;

  const merchantAccount = await exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = 'stripe' LIMIT 1`,
  );
  if (!merchantAccount) return;

  throw new HandBackToRails();
}
