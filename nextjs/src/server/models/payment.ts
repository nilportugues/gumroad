// The Payment queries the money jobs need (app/models/payment.rb). Payment's state machine and
// callbacks are not ported; the lift-platform-stripe-pause job keeps its own payment reads.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "./sql.ts";

// `user.payments.completed.where(stripe_connect_account_id:).order(:created_at).pluck(:stripe_internal_transfer_id)`
export async function completedInternalTransferIds(userId: unknown, stripeConnectAccountId: string): Promise<(string | null)[]> {
  const rows = await selectRows<{ stripe_internal_transfer_id: string | null }>(
    Prisma.sql`SELECT ${column("payments", "stripe_internal_transfer_id")} FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${userId} AND ${column("payments", "state")} = 'completed' AND ${column("payments", "stripe_connect_account_id")} = ${stripeConnectAccountId} ORDER BY ${column("payments", "created_at")} ASC`,
  );
  return rows.map((row) => row.stripe_internal_transfer_id);
}
