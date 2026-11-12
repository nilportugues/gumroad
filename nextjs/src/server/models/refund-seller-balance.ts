// Purchase#process_refund_or_chargeback_for_purchase_balance for a refund (app/models/purchase.rb), with what it calls:
// BalanceTransaction.create!(refund:), update_balance! and the refund branch of find_or_create_balance
// (app/models/balance_transaction.rb), then `purchase_refund_balance` and the purchase's save.
// Golden: __fixtures__/refund-seller-balance.golden.json (scripts/golden/refund-seller-balance.rb), run by the real classes.
//
// Its own file, not an edit of balance-transaction.ts: that model still refuses every refund and is being changed for the purchase
// side (ws21-purchase-model). This file defines a second model over the same table whose validations accept a refund and
// copies update_balance!, so the two can merge without a conflict; fold them together when both settle.
//
// Not served by any route: the Refund insert and every other write of refund_purchase! are still Rails'. A buyer-currency
// presentment is refused (NotPortedError) before the first write, like the sale's.
import { Prisma, type BalanceTransaction } from "@prisma/client";

import { balanceTransactionAmountsForSale, type SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import type { Amount } from "./balance-transaction.ts";
import { Balances, createBalanceBang, type BalanceRecord } from "./balance.ts";
import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { belongsToRequired, loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { chargedUsingGumroadMerchantAccount, type ChargeMerchantAccount } from "./purchase-charge-facts.ts";
import { Purchases, type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import { purchaseOf, Refunds, type RefundRecord } from "./refund.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, connection, isLockWaitTimeout, isRecordNotUnique, selectRows, table } from "./sql.ts";
import { NotPortedError, Users, type UserRecord } from "./user.ts";

type BalanceTransactionRecord = ModelRecord<BalanceTransaction>;

// BalanceTransaction::MAX_ATTEMPTS_TO_UPDATE_BALANCE and the lock-wait backoff of update_balance!
const MAX_ATTEMPTS_TO_UPDATE_BALANCE = 3;
const LOCK_RETRY_BACKOFF_SECONDS = 0.5;
// Attributes BalanceTransaction marks `attr_mutable`
const MUTABLE_ATTRIBUTES = ["deleted_at", "updated_at", "balance_id"];

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};
const REFUND: BelongsTo = { name: "refund", foreignKey: "refund_id", targetTable: "refunds", targetModel: "Refund" };

const notPorted = (what: string) =>
  new NotPortedError(
    `Purchase#process_refund_or_chargeback_for_purchase_balance with ${what}`,
    "app/models/purchase.rb:2790",
  );

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
const toDate = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

class RefundBalanceCouldNotBeFoundOrCreated extends Error {
  readonly rubyClass = "BalanceTransaction::BalanceCouldNotBeFoundOrCreated";
  constructor(balanceTransactionId: unknown) {
    super(`A suitable balance for transaction ${String(balanceTransactionId)} could not be found or created.`);
  }
}

class RefundBalanceTransactionImmutable extends Error {
  readonly rubyClass = "Immutable::RecordImmutable";
  constructor(attributes: string[]) {
    super(
      `The record is immutable but the attributes ${JSON.stringify(attributes).replaceAll(",", ", ")} were attempted to be changed, but are not excluded from this models immutability.`,
    );
  }
}

// BalanceTransaction for a row that belongs to a refund: `validate_exactly_one_of_purchase_dispute_refund_credit_is_present` is
// satisfied by the refund alone. A row that carries another owner is not this model's.
export const RefundBalanceTransactions = defineModel<BalanceTransaction>({
  rubyClass: "BalanceTransaction",
  prismaModel: "BalanceTransaction",
  delegate: (tx) => tx.balanceTransaction as never,
  validations: [
    belongsToRequired<BalanceTransaction>(USER),
    belongsToRequired<BalanceTransaction>(MERCHANT_ACCOUNT),
    {
      name: "validate_exactly_one_of_purchase_dispute_refund_credit_is_present",
      async run(bt, ctx) {
        for (const owner of ["purchase_id", "dispute_id", "credit_id"] as const) {
          if (bt.get(owner) != null)
            throw new NotPortedError(
              `BalanceTransaction of a refund that also has ${owner}`,
              "app/models/balance_transaction.rb",
            );
        }
        if ((await loadBelongsTo(bt, REFUND, ctx)) === null)
          bt.errors.add("base", "can only have one of: purchase, dispute, refund, credit");
      },
    },
  ],
  beforeUpdate: [
    {
      name: "immutable",
      run(bt) {
        const changed = bt.changedAttributeNames().filter((name) => !MUTABLE_ATTRIBUTES.includes(name));
        if (changed.length > 0) throw new RefundBalanceTransactionImmutable(changed);
      },
    },
  ],
});

// refund_balance_transaction.find_or_create_balance: the seller's oldest open balance, the one of the day the sale succeeded first,
// else a new balance dated the day of the refund.
async function findOrCreateRefundBalance(bt: BalanceTransactionRecord, options: SaveOptions): Promise<BalanceRecord> {
  const user = await readBelongsTo(bt, USER, Users);
  const merchantAccount = await readBelongsTo(bt, MERCHANT_ACCOUNT, MerchantAccounts);
  if (user === null || merchantAccount === null) throw new TypeError("undefined method for nil");
  const currency = bt.get("issued_amount_currency");
  const holdingCurrency = bt.get("holding_amount_currency");
  const unpaidBalances = (extra?: Prisma.Sql) =>
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "merchant_account_id")} = ${merchantAccount.get("id")} AND ${column("balances", "currency")} = ${currency} AND ${column("balances", "holding_currency")} = ${holdingCurrency} AND ${column("balances", "state")} = 'unpaid'${extra ?? Prisma.empty} ORDER BY ${column("balances", "date")} ASC LIMIT 1`;
  const first = async (extra?: Prisma.Sql) => {
    const [row] = await selectRows(unpaidBalances(extra));
    return row ? Balances.load(castRow("Balance", row)) : null;
  };
  const onDay = (day: Date) => Prisma.sql` AND ${column("balances", "date")} = ${day.toISOString().slice(0, 10)}`;

  const refund = await readBelongsTo(bt, REFUND, Refunds);
  if (refund === null) throw new TypeError("undefined method 'purchase' for nil");
  // A refund's purchase can have no succeeded_at: the charge went through while the purchase was never marked successful.
  const succeededAt = (await purchaseOf(refund))?.succeeded_at as Date | null | undefined;
  let balance = succeededAt ? await first(onDay(toDate(succeededAt))) : null;
  balance ??= await first();

  if (balance === null) {
    const occurredAt = toDate(refund.get("created_at") as Date);
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
      balance = await first(onDay(occurredAt));
    }
  }
  if (balance === null) throw new RefundBalanceCouldNotBeFoundOrCreated(bt.get("id"));
  return balance;
}

// update_balance!, for a refund's transaction
async function updateRefundBalanceBang(
  bt: BalanceTransactionRecord,
  options: SaveOptions = {},
  retryDeps: { sleep?: (seconds: number) => Promise<void> } = {},
): Promise<void> {
  let failedCount = 1;
  let lockFailedCount = 0;
  for (;;) {
    try {
      if ((await RefundBalanceTransactions.reload(bt)).get("balance_id") != null) return;
      const locked = await findOrCreateRefundBalance(bt, options);
      await Balances.withLock(locked, async () => {
        // Lock after the Balance, then recheck: another attempt may have applied this transaction.
        await RefundBalanceTransactions.lockBang(bt);
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
        bt.set("balance_id", locked.get("id") as never);
        await RefundBalanceTransactions.saveBang(bt, options);
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

// BalanceTransaction.create!(user:, merchant_account:, refund:, issued_amount:, holding_amount:)
export async function createRefundBalanceTransactionBang(
  attributes: {
    user: UserRecord;
    merchantAccount: MerchantAccountRecord;
    refund: RefundRecord;
    issuedAmount: Amount;
    holdingAmount: Amount;
  },
  options: SaveOptions = {},
  retryDeps: { sleep?: (seconds: number) => Promise<void> } = {},
): Promise<BalanceTransactionRecord> {
  const bt = RefundBalanceTransactions.build({
    issued_amount_currency: attributes.issuedAmount.currency,
    issued_amount_gross_cents: attributes.issuedAmount.grossCents,
    issued_amount_net_cents: attributes.issuedAmount.netCents,
    holding_amount_currency: attributes.holdingAmount.currency,
    holding_amount_gross_cents: attributes.holdingAmount.grossCents,
    holding_amount_net_cents: attributes.holdingAmount.netCents,
  });
  assignBelongsTo(bt, USER, attributes.user);
  assignBelongsTo(bt, MERCHANT_ACCOUNT, attributes.merchantAccount);
  assignBelongsTo(bt, REFUND, attributes.refund);
  await RefundBalanceTransactions.saveBang(bt, options);
  // Balance selection stays outside the insert's transaction, as in Rails.
  await updateRefundBalanceBang(bt, options, retryDeps);
  return bt;
}

// `purchase_presentment.present?` (has_one): the first read loads it
async function hasPresentment(record: PurchaseRecord): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_presentments`.*")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} = ${record.get("id")} LIMIT 1`,
  );
  return rows.length > 0;
}

export type RefundSellerBalanceFacts = {
  // The flow of funds the refund produced (StripeChargeRefund#build_flow_of_funds)
  flowOfFunds: SellerFlowOfFunds;
  // what the seller is debited, positive
  refundCents: number;
};

// Purchase#process_refund_or_chargeback_for_purchase_balance(flow_of_funds, refund:, refund_cents:)
export async function processRefundForPurchaseBalanceBang(
  record: PurchaseRecord,
  refund: RefundRecord,
  facts: RefundSellerBalanceFacts,
  options: SaveOptions = {},
): Promise<void> {
  if (facts.refundCents === 0) return;

  const accountRow = (await loadBelongsTo(record, MERCHANT_ACCOUNT, {
    tx: (await connection()) as never,
  })) as ChargeMerchantAccount | null;
  if (!chargedUsingGumroadMerchantAccount(accountRow, record.get("charge_processor_id"))) return;
  if (accountRow === null) throw notPorted("no merchant account");
  if (await hasPresentment(record)) throw notPorted("a buyer-currency presentment");

  const amounts = balanceTransactionAmountsForSale({
    flowOfFunds: facts.flowOfFunds,
    issuedNetCents: -1 * facts.refundCents,
    canonicalIssuedAmount: null,
    gumroadHeld: false,
  });
  const context = record.ivars.context as PurchaseContext;
  const bt = await createRefundBalanceTransactionBang(
    {
      user: Users.load(context.seller),
      merchantAccount: MerchantAccounts.load(castRow("MerchantAccount", accountRow as never)) as MerchantAccountRecord,
      refund,
      issuedAmount: amounts.issued,
      holdingAmount: amounts.holding,
    },
    options,
  );
  record.set("purchase_refund_balance_id", bt.get("balance_id") as never);
  await Purchases.saveBang(record, options);
}
