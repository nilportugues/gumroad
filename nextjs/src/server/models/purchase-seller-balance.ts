// Purchase#increment_sellers_balance! for a sale with no buyer-currency presentment: the affiliate's credit first when the sale
// has one (purchase-affiliate-credit.ts), then the seller's BalanceTransaction (and the day's Balance it lands on) and the
// purchase's `purchase_success_balance_id`.
// Goldens: __fixtures__/purchase-seller-balance.golden.json (scripts/golden/purchase-seller-balance.rb) and
// __fixtures__/purchase-affiliate-balance.golden.json (scripts/golden/purchase-affiliate-balance.rb), run by the real class.
//
// Everything that decides whether the shape is served happens before the first write, so the caller can hand the order back:
// a collaborator's credit, a direct affiliate, a presentment and a purchase with no merchant account are refused with
// NotPortedError. Past the first write nothing here refuses; a failure there is a Rails failure too and propagates the same way.
import { Prisma } from "@prisma/client";

import { balanceTransactionAmountsForSale } from "./balance-transaction-amounts.ts";
import type { SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import {
  balanceTransactionBalance,
  BalanceTransactions,
  createBalanceTransactionBang,
  type BalanceTransactionRecord,
} from "./balance-transaction.ts";
import { defaultCheckoutEffects } from "./checkout-effects.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { incrementAffiliatesBalanceBang } from "./purchase-affiliate-credit.ts";
import { chargedUsingGumroadMerchantAccount, type ChargeMerchantAccount } from "./purchase-charge-facts.ts";
import { Purchases, type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, connection, selectRows, table } from "./sql.ts";
import { NotPortedError, Users } from "./user.ts";

const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#increment_sellers_balance! with ${what}`, "app/models/purchase.rb:2124");

// `purchase_presentment.present?` (has_one): the first read loads it
async function hasPresentment(record: PurchaseRecord): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_presentments`.*")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} = ${record.get("id")} LIMIT 1`,
  );
  return rows.length > 0;
}

// `balance_transactions.where(user: seller).where.not(balance_id: nil).last`
async function lastAppliedSellerTransaction(record: PurchaseRecord): Promise<BalanceTransactionRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balance_transactions`.*")} FROM ${table("balance_transactions")} WHERE ${column("balance_transactions", "purchase_id")} = ${record.get("id")} AND ${column("balance_transactions", "user_id")} = ${record.get("seller_id")} AND ${Prisma.raw("`balance_transactions`.`balance_id` IS NOT NULL")} ORDER BY ${column("balance_transactions", "id")} DESC LIMIT 1`,
  );
  return row ? BalanceTransactions.load(castRow("BalanceTransaction", row)) : null;
}

export type SellerBalanceFacts = {
  // The flow of funds the processor charge produced (Purchase#flow_of_funds)
  flowOfFunds: SellerFlowOfFunds;
};

export async function incrementSellersBalanceBang(
  record: PurchaseRecord,
  facts: SellerBalanceFacts,
  options: SaveOptions = {},
): Promise<void> {
  if (record.get("price_cents") === 0) return;

  // direct_affiliate_id lives in json_data (attr_json_data_accessor)
  if (String(record.get("json_data") ?? "").includes("direct_affiliate_id")) throw notPorted("a direct affiliate");
  const creditsAffiliate = (record.get("affiliate_credit_cents") ?? 0) > 0;
  const merchantAccountRow = async () =>
    (await loadBelongsTo(record, MERCHANT_ACCOUNT, {
      tx: (await connection()) as never,
    })) as ChargeMerchantAccount | null;

  if (creditsAffiliate) {
    // Ruby credits the affiliate before it reads anything the seller's share could be refused for, so those are read first:
    // the checks that need no query, and the presentment (the one SELECT the replay moves ahead of the affiliate's).
    if (record.get("merchant_account_id") == null) throw notPorted("no merchant account");
    if (record.get("fee_cents") == null) throw notPorted("no fee");
    if (record.get("succeeded_at") == null) throw notPorted("no succeeded_at");
    if (await hasPresentment(record)) throw notPorted("a buyer-currency presentment");
    const context = record.ivars.context as PurchaseContext;
    await incrementAffiliatesBalanceBang(
      record,
      {
        effects: context.effects ?? defaultCheckoutEffects,
        chargedUsingGumroad: async () =>
          chargedUsingGumroadMerchantAccount(await merchantAccountRow(), record.get("charge_processor_id")),
      },
      options,
    );
  }

  const accountRow = await merchantAccountRow();
  if (!chargedUsingGumroadMerchantAccount(accountRow, record.get("charge_processor_id"))) return;
  if (accountRow === null) throw notPorted("no merchant account");

  const existing = await lastAppliedSellerTransaction(record);
  if (existing) {
    // The sale was booked before. Ruby assigns the association first and then saves only when the id differs, which it never
    // does, so the link stays in memory until a later save of the purchase.
    const balance = await balanceTransactionBalance(existing);
    record.set("purchase_success_balance_id", (balance?.get("id") ?? null) as never);
    return;
  }

  if (record.get("fee_cents") == null) throw notPorted("no fee");
  if (record.get("succeeded_at") == null) throw notPorted("no succeeded_at");
  if (!creditsAffiliate && (await hasPresentment(record))) throw notPorted("a buyer-currency presentment");

  const issuedNetCents =
    (record.get("price_cents") ?? 0) - record.get("fee_cents")! - (record.get("affiliate_credit_cents") ?? 0);
  const amounts = balanceTransactionAmountsForSale({
    flowOfFunds: facts.flowOfFunds,
    issuedNetCents,
    canonicalIssuedAmount: null,
    gumroadHeld: false,
  });

  const merchantAccount = MerchantAccounts.load(
    castRow("MerchantAccount", accountRow as never),
  ) as MerchantAccountRecord;
  const context = record.ivars.context as PurchaseContext;
  const bt = await createBalanceTransactionBang(
    {
      user: Users.load(context.seller),
      merchantAccount,
      purchase: record as never,
      issuedAmount: amounts.issued,
      holdingAmount: amounts.holding,
    },
    options,
  );
  record.set("purchase_success_balance_id", bt.get("balance_id") as never);
  await Purchases.saveBang(record, options);
}
