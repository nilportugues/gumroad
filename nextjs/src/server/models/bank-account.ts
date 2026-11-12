// The slice of app/models/bank_account.rb that account adoption runs: `mark_deleted!(validate: false)` and the
// after_update_commit that refreshes the seller's recommendable products. Only the required user is validated; a bank account is
// only ever retired here, never created or edited.
import { Prisma, type BankAccount } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "./merchant-account.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { Users } from "./user.ts";

const BANK_USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };

const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";

// BankAccount#user_has_another_payout_method?: `user.payment_address.present?` loads the user, `.exists?` sends `SELECT 1 AS one`, and
// `has_paypal_account_connected?` loads every live PayPal account before asking whether there is one.
async function userHasAnotherPayoutMethod(
  record: ModelRecord<BankAccount>,
  userId: unknown,
  bankAccountId: unknown,
): Promise<boolean> {
  // `user.payment_address` goes through the association, which a validated save already loaded.
  const user = await readBelongsTo(record, BANK_USER, Users);
  if (!user) throw new TypeError("undefined method 'payment_address' for nil");
  if (!isBlank(user.get("payment_address"))) return true;
  const banks = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL AND ${column("bank_accounts", "id")} != ${bankAccountId} LIMIT 1`,
  );
  if (banks.length > 0) return true;
  if ((await aliveStripeAccountsOf(userId)).some((account) => isStripeConnectAccount(account))) return true;
  const paypal = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID}`,
  );
  return paypal.length > 0;
}

// `user.active_bank_account` sets the inverse association, so the bank account validates against that user without reading it.
export const assignBankAccountUser = (bank: ModelRecord<BankAccount>, user: Parameters<typeof assignBelongsTo>[2]) =>
  assignBelongsTo(bank, BANK_USER, user);

export const BankAccounts = defineModel<BankAccount>({
  rubyClass: "BankAccount",
  prismaModel: "BankAccount",
  delegate: (tx) => tx.bankAccount as never,
  // The only validation ported: `belongs_to :user` is required, which loads the user on every validated save (a payout Stripe cannot
  // pay deletes the bank account without `validate: false`).
  validations: [belongsToRequired<BankAccount>(BANK_USER)],
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
          if (await userHasAnotherPayoutMethod(record, record.get("user_id"), record.get("id"))) return;
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
