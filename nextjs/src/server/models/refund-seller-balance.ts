// Purchase#process_refund_or_chargeback_for_purchase_balance for a refund (app/models/purchase.rb): the seller's refund
// BalanceTransaction (balance-transaction.ts, whose refund branch of find_or_create_balance books it), then `purchase_refund_balance`
// and the purchase's save.
// Golden: __fixtures__/refund-seller-balance.golden.json (scripts/golden/refund-seller-balance.rb), run by the real classes.
//
// Not served by any route: the Refund insert and every other write of refund_purchase! are still Rails'. A buyer-currency
// presentment is refused (NotPortedError) before the first write, like the sale's.
import { Prisma } from "@prisma/client";

import { balanceTransactionAmountsForSale, type SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import { createBalanceTransactionBang } from "./balance-transaction.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { chargedUsingGumroadMerchantAccount, type ChargeMerchantAccount } from "./purchase-charge-facts.ts";
import { Purchases, type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import type { RefundRecord } from "./refund.ts";
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
  new NotPortedError(
    `Purchase#process_refund_or_chargeback_for_purchase_balance with ${what}`,
    "app/models/purchase.rb:2790",
  );

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
  const bt = await createBalanceTransactionBang(
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
