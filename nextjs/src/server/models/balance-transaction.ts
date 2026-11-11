// Port of app/models/balance_transaction.rb for credits: BalanceTransaction.create!, update_balance!
// (the balance lock, the retry on an invalid balance) and find_or_create_balance. Balance
// transactions for purchases, refunds and disputes are refused with NotPortedError: their models
// are not ported. Golden: worker/jobs/__fixtures__/money-jobs.golden.json.
import { Prisma, type BalanceTransaction, type Balance } from "@prisma/client";

import { Balances, createBalanceBang, type BalanceRecord } from "./balance.ts";
import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { capitalDeductionDate, Credits, type CreditRecord } from "./credit.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, isLockWaitTimeout, isRecordNotUnique, selectRows, table } from "./sql.ts";
import { NotPortedError, Users, type UserRecord } from "./user.ts";

export type BalanceTransactionRecord = ModelRecord<BalanceTransaction>;

// BalanceTransaction::Amount
export type Amount = { currency: string; grossCents: number; netCents: number };

const MAX_ATTEMPTS_TO_UPDATE_BALANCE = 3;
const LOCK_RETRY_BACKOFF_SECONDS = 0.5;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};
const CREDIT: BelongsTo = { name: "credit", foreignKey: "credit_id", targetTable: "credits", targetModel: "Credit" };
const BALANCE: BelongsTo = {
  name: "balance",
  foreignKey: "balance_id",
  targetTable: "balances",
  targetModel: "Balance",
};

export const balanceTransactionUser = (bt: BalanceTransactionRecord) => readBelongsTo(bt, USER, Users);
export const balanceTransactionMerchantAccount = (bt: BalanceTransactionRecord) =>
  readBelongsTo(bt, MERCHANT_ACCOUNT, MerchantAccounts);
export const balanceTransactionCredit = (bt: BalanceTransactionRecord) => readBelongsTo(bt, CREDIT, Credits);
export const balanceTransactionBalance = (bt: BalanceTransactionRecord) => readBelongsTo(bt, BALANCE, Balances);

// Immutable: only these attributes may change after the insert (`attr_mutable`).
const MUTABLE_ATTRIBUTES = ["deleted_at", "updated_at", "balance_id"];

export class RecordImmutable extends Error {
  readonly rubyClass = "Immutable::RecordImmutable";
  constructor(attributes: string[]) {
    super(
      `The record is immutable but the attributes ${JSON.stringify(attributes).replaceAll(",", ", ")} were attempted to be changed, but are not excluded from this models immutability.`,
    );
  }
}

export class BalanceCouldNotBeFoundOrCreated extends Error {
  readonly rubyClass = "BalanceTransaction::BalanceCouldNotBeFoundOrCreated";
  constructor(balanceTransactionId: unknown) {
    super(`A suitable balance for transaction ${String(balanceTransactionId)} could not be found or created.`);
  }
}

// purchase.present? ^ dispute.present? ^ refund.present? ^ credit.present?
function refuseOtherEntities(bt: BalanceTransactionRecord, what: string): void {
  for (const [column_, name] of [
    ["purchase_id", "purchase"],
    ["dispute_id", "dispute"],
    ["refund_id", "refund"],
  ] as const) {
    if (bt.get(column_) != null)
      throw new NotPortedError(`BalanceTransaction ${what} for a ${name}`, "app/models/balance_transaction.rb");
  }
}

export const BalanceTransactions = defineModel<BalanceTransaction>({
  rubyClass: "BalanceTransaction",
  prismaModel: "BalanceTransaction",
  delegate: (tx) => tx.balanceTransaction as never,
  validations: [
    belongsToRequired<BalanceTransaction>(USER),
    belongsToRequired<BalanceTransaction>(MERCHANT_ACCOUNT),
    {
      name: "validate_exactly_one_of_purchase_dispute_refund_credit_is_present",
      async run(bt) {
        refuseOtherEntities(bt, "validation");
        if (!(await balanceTransactionCredit(bt))) {
          bt.errors.add("base", "can only have one of: purchase, dispute, refund, credit");
        }
      },
    },
  ],
  beforeUpdate: [
    {
      name: "immutable",
      run(bt) {
        const changed = bt.changedAttributeNames().filter((name) => !MUTABLE_ATTRIBUTES.includes(name));
        if (changed.length > 0) throw new RecordImmutable(changed);
      },
    },
  ],
});

const toDate = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

// find_or_create_balance
export async function findOrCreateBalance(
  bt: BalanceTransactionRecord,
  options: SaveOptions = {},
): Promise<BalanceRecord> {
  const user = await balanceTransactionUser(bt);
  const merchantAccount = await balanceTransactionMerchantAccount(bt);
  if (user === null || merchantAccount === null) throw new TypeError("undefined method for nil");
  const currency = bt.get("issued_amount_currency");
  const holdingCurrency = bt.get("holding_amount_currency");
  const unpaidBalances = (extra?: Prisma.Sql) =>
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "merchant_account_id")} = ${merchantAccount.get("id")} AND ${column("balances", "currency")} = ${currency} AND ${column("balances", "holding_currency")} = ${holdingCurrency} AND ${column("balances", "state")} = 'unpaid'${extra ?? Prisma.empty} ORDER BY ${column("balances", "date")} ASC LIMIT 1`;
  const first = async (extra?: Prisma.Sql) => {
    const [row] = await selectRows(unpaidBalances(extra));
    return row ? Balances.load(castRow<Balance>("Balance", row)) : null;
  };

  refuseOtherEntities(bt, "balance selection");
  const credit = await balanceTransactionCredit(bt);
  // credit&.financing_paydown_purchase, credit&.fee_retention_refund
  if (
    credit &&
    (credit.get("financing_paydown_purchase_id") != null || credit.get("fee_retention_refund_id") != null)
  ) {
    throw new NotPortedError(
      "BalanceTransaction balance selection for a financing paydown or fee retention credit",
      "app/models/balance_transaction.rb:177",
    );
  }
  // elsif credit
  let balance = credit ? await first() : null;

  if (balance === null) {
    if (!credit) throw new BalanceCouldNotBeFoundOrCreated(bt.get("id"));
    if (credit.get("returned_payment_id") != null)
      throw new NotPortedError(
        "BalanceTransaction balance date for a returned payment",
        "app/models/balance_transaction.rb:195",
      );
    const occurredAt = capitalDeductionDate(credit) ?? toDate(credit.get("created_at") as Date);
    try {
      balance = await createBalanceBang(
        {
          user,
          merchantAccount,
          currency: currency as string,
          holdingCurrency: holdingCurrency as string,
          date: occurredAt,
        },
        options,
      );
    } catch (error) {
      if (!(error instanceof RecordInvalid || isRecordNotUnique(error))) throw error;
      balance = await first(Prisma.sql` AND ${column("balances", "date")} = ${occurredAt}`);
    }
  }
  if (balance === null) throw new BalanceCouldNotBeFoundOrCreated(bt.get("id"));
  return balance;
}

// update_balance!(target_balance: nil)
export async function updateBalanceBang(
  bt: BalanceTransactionRecord,
  options: SaveOptions = {},
  targetBalance: BalanceRecord | null = null,
  retryDeps: { sleep?: (seconds: number) => Promise<void> } = {},
): Promise<void> {
  let failedCount = 1;
  let lockFailedCount = 0;
  for (;;) {
    let balance: BalanceRecord | null = null;
    try {
      if ((await BalanceTransactions.reload(bt)).get("balance_id") != null) return;
      balance = targetBalance ?? (await findOrCreateBalance(bt, options));
      const locked = balance;
      await Balances.withLock(locked, async () => {
        // Lock after the Balance, then recheck: another attempt may have applied this transaction.
        await BalanceTransactions.lockBang(bt);
        if (bt.get("balance_id") != null) return;
        locked.set(
          "amount_cents",
          ((locked.get("amount_cents") as number | null) ?? 0) + (bt.get("issued_amount_net_cents") as number),
        );
        locked.set(
          "holding_amount_cents",
          ((locked.get("holding_amount_cents") as number | null) ?? 0) + (bt.get("holding_amount_net_cents") as number),
        );
        await Balances.saveBang(locked, options);
        assignBelongsTo(bt, BALANCE, locked);
        await BalanceTransactions.saveBang(bt, options);
      });
      return;
    } catch (error) {
      if (isLockWaitTimeout(error)) {
        lockFailedCount += 1;
        if (lockFailedCount >= MAX_ATTEMPTS_TO_UPDATE_BALANCE) throw error;
        await (retryDeps.sleep ?? sleep)(lockFailedCount * LOCK_RETRY_BACKOFF_SECONDS);
        continue;
      }
      // Saving the balance can fail if its state changed between selection and locking.
      if (!(error instanceof RecordInvalid)) throw error;
      failedCount += 1;
      if (failedCount >= MAX_ATTEMPTS_TO_UPDATE_BALANCE) throw error;
    }
  }
}

// BalanceTransaction.create!
export async function createBalanceTransactionBang(
  attributes: {
    user: UserRecord;
    merchantAccount: MerchantAccountRecord;
    credit: CreditRecord;
    issuedAmount: Amount;
    holdingAmount: Amount;
    updateUserBalance?: boolean;
  },
  options: SaveOptions = {},
): Promise<BalanceTransactionRecord> {
  const bt = BalanceTransactions.build({
    issued_amount_currency: attributes.issuedAmount.currency,
    issued_amount_gross_cents: attributes.issuedAmount.grossCents,
    issued_amount_net_cents: attributes.issuedAmount.netCents,
    holding_amount_currency: attributes.holdingAmount.currency,
    holding_amount_gross_cents: attributes.holdingAmount.grossCents,
    holding_amount_net_cents: attributes.holdingAmount.netCents,
  });
  assignBelongsTo(bt, USER, attributes.user);
  assignBelongsTo(bt, MERCHANT_ACCOUNT, attributes.merchantAccount);
  assignBelongsTo(bt, CREDIT, attributes.credit);
  await BalanceTransactions.saveBang(bt, options);
  // The balances are updated outside of the save, so that selecting and locking them is not part
  // of a transaction that may implicitly lock other records.
  if (attributes.updateUserBalance !== false) await updateBalanceBang(bt, options);
  return bt;
}
