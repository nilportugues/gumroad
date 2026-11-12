// Credit.create_for_refund_fee_retention!(refund:) (app/models/credit.rb): the writes. The arithmetic is refund-fee-retention.ts.
//   - a Stripe Connect sale credits the seller what the application fee returns (Gumroad tax and the affiliate share, in proportion to
//     the refund) on Gumroad's own account;
//   - any other sale debits the processor fee, on the sale's account, records it as the refund's retained fee and, for an account
//     Gumroad manages for the seller, marks the collection from Stripe as pending (Refund#recover_pending_fee_retention! runs it after
//     the transaction commits, and is not here).
// The credit's balance transaction lands on the oldest open balance (balance-transaction.ts, `credit&.fee_retention_refund`).
// Golden: __fixtures__/refund-fee-retention-credit.golden.json (scripts/golden/refund-fee-retention-credit.rb), run by the real classes.
import type { MerchantAccount } from "@prisma/client";

import { balanceTransactionBalance, createBalanceTransactionBang } from "./balance-transaction.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { usdCentsToCurrency } from "./concerns/currency-helper.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import {
  assignCreditFeeRetentionRefund,
  assignCreditMerchantAccount,
  assignCreditUser,
  Credits,
  type CreditRecord,
} from "./credit.ts";
import {
  gumroadMerchantAccountFor,
  HOLDER_OF_FUNDS,
  holderOfFunds,
  MerchantAccounts,
  type MerchantAccountRecord,
} from "./merchant-account.ts";
import {
  chargedUsingGumroadMerchantAccount,
  STRIPE_PROCESSOR,
  type ChargeMerchantAccount,
} from "./purchase-charge-facts.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { sellerOf } from "./purchase-reloaded-associations.ts";
import { refundFeeRetention } from "./refund-fee-retention.ts";
import { assignRefundAttribute, Refunds, type RefundRecord } from "./refund.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, connection } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};
const BALANCE: BelongsTo = {
  name: "balance",
  foreignKey: "balance_id",
  targetTable: "balances",
  targetModel: "Balance",
};

// `credit.balance = balance_transaction.balance; credit.save!`
async function attachBalance(
  credit: CreditRecord,
  balanceTransaction: Parameters<typeof balanceTransactionBalance>[0],
  options: SaveOptions,
) {
  assignBelongsTo(credit, BALANCE, await balanceTransactionBalance(balanceTransaction));
  await Credits.saveBang(credit, options);
}

// `refund` has been appended to `purchase` (so the refund's purchase is this record). Returns null where Ruby returns nil.
export async function createForRefundFeeRetentionBang(
  purchase: PurchaseRecord,
  refund: RefundRecord,
  options: SaveOptions = {},
): Promise<CreditRecord | null> {
  const accountRow = (await loadBelongsTo(purchase, MERCHANT_ACCOUNT, {
    tx: (await connection()) as never,
  })) as ChargeMerchantAccount | null;
  const charged = chargedUsingGumroadMerchantAccount(accountRow, purchase.get("charge_processor_id"));
  const seller = await sellerOf(purchase);
  const sale = {
    priceCents: purchase.get("price_cents")!,
    processorFeeCents: purchase.get("processor_fee_cents") ?? null,
    processorFeeCentsCurrency: purchase.get("processor_fee_cents_currency") ?? null,
    gumroadTaxCents: purchase.get("gumroad_tax_cents") ?? 0,
    affiliateCreditCents: purchase.get("affiliate_credit_cents") ?? 0,
  };
  const refundAmountCents = refund.get("amount_cents")!;

  if (!charged) {
    const retention = await refundFeeRetention({
      sale,
      refundAmountCents,
      chargedUsingGumroadMerchantAccount: false,
      holderOfFunds: HOLDER_OF_FUNDS.GUMROAD,
      merchantCurrency: "usd",
      usdCentsToCurrency,
    });
    if (retention === null) return null;
    const credit = Credits.build({});
    assignCreditUser(credit, seller);
    credit.set("amount_cents", retention.creditAmountCents);
    const gumroadAccount = await gumroadMerchantAccountFor(STRIPE_PROCESSOR);
    assignCreditMerchantAccount(credit, gumroadAccount);
    assignCreditFeeRetentionRefund(credit, refund);
    await Credits.saveBang(credit, options);
    const balanceTransaction = await createBalanceTransactionBang(
      {
        user: seller,
        merchantAccount: gumroadAccount!,
        credit,
        issuedAmount: retention.issuedAmount,
        holdingAmount: retention.holdingAmount,
      },
      options,
    );
    await attachBalance(credit, balanceTransaction, options);
    return credit;
  }

  if (accountRow === null)
    throw new NotPortedError(
      "Credit.create_for_refund_fee_retention! with no merchant account",
      "app/models/credit.rb:353",
    );
  const merchantAccount: MerchantAccountRecord = MerchantAccounts.load(
    castRow<MerchantAccount>("MerchantAccount", accountRow as never),
  );
  const retention = await refundFeeRetention({
    sale,
    refundAmountCents,
    chargedUsingGumroadMerchantAccount: true,
    // Decided after the retained fee is saved, as Ruby reads the holder there.
    holderOfFunds: "unread",
    merchantCurrency: merchantAccount.get("currency")!,
    usdCentsToCurrency,
  });
  const credit = Credits.build({});
  assignCreditUser(credit, seller);
  credit.set("amount_cents", retention!.creditAmountCents);
  assignCreditMerchantAccount(credit, merchantAccount);
  assignCreditFeeRetentionRefund(credit, refund);
  await Credits.saveBang(credit, options);

  assignRefundAttribute(refund, "retained_fee_cents", retention!.retainedFeeCents);
  await Refunds.saveBang(refund, options);

  if ((await holderOfFunds(merchantAccount)) === HOLDER_OF_FUNDS.STRIPE) {
    // No Stripe call here: the caller's transaction commits first.
    assignRefundAttribute(refund, "fee_retention_pending", retention!.creditAmountCents !== 0);
    await Refunds.saveBang(refund, options);
  }

  const balanceTransaction = await createBalanceTransactionBang(
    {
      user: seller,
      merchantAccount,
      credit,
      issuedAmount: retention!.issuedAmount,
      holdingAmount: retention!.holdingAmount,
    },
    options,
  );
  await attachBalance(credit, balanceTransaction, options);
  return credit;
}
