// The slice of app/models/bank_account.rb that account adoption runs: `mark_deleted!(validate: false)` and the
// after_update_commit that refreshes the seller's recommendable products. No validation is ported; a bank account is only
// ever retired here, never created or edited.
import { Prisma, type BankAccount } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "./merchant-account.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";

// BankAccount#user_has_another_payout_method?
async function userHasAnotherPayoutMethod(userId: unknown, bankAccountId: unknown): Promise<boolean> {
  const [user] = await selectRows<{ payment_address: string | null }>(
    Prisma.sql`SELECT ${column("users", "payment_address")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
  );
  if (user && !isBlank(user.payment_address)) return true;
  const banks = await selectRows(
    Prisma.sql`SELECT 1 AS present FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL AND ${column("bank_accounts", "id")} != ${bankAccountId} LIMIT 1`,
  );
  if (banks.length > 0) return true;
  if ((await aliveStripeAccountsOf(userId)).some((account) => isStripeConnectAccount(account))) return true;
  const paypal = await selectRows(
    Prisma.sql`SELECT 1 AS present FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID} LIMIT 1`,
  );
  return paypal.length > 0;
}

export const BankAccounts = defineModel<BankAccount>({
  rubyClass: "BankAccount",
  prismaModel: "BankAccount",
  delegate: (tx) => tx.bankAccount as never,
  afterCommit: [
    {
      name: "enqueue_user_products_recommendability_refresh",
      on: "update",
      // active_status_changed?: saved_change_to_deleted_at.any?(&:nil?), which a deletion satisfies too.
      if: (record) => {
        const change = record.savedChanges.deleted_at;
        return change !== undefined && (change[0] == null || change[1] == null);
      },
      async run(record) {
        try {
          if (await userHasAnotherPayoutMethod(record.get("user_id"), record.get("id"))) return;
          await performAsync("RefreshUserProductsRecommendationEligibilityJob", [Number(record.get("user_id"))]);
        } catch (error) {
          notifyError(error, { bank_account_id: record.get("id"), user_id: record.get("user_id") });
        }
      },
    },
  ],
});

export const BankAccountDeletable = deletable(BankAccounts);

// `user.bank_accounts.alive`, in primary key order.
export async function aliveBankAccountsOf(userId: unknown) {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`bank_accounts`.*")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC`,
  );
  return rows.map((row) => BankAccounts.load(castRow<BankAccount>("BankAccount", row)));
}
