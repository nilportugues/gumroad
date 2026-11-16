// Credit.create_for_vat_exclusive_refund!(refund:) (app/models/credit.rb): a VAT that was refunded apart from the sale leaves Gumroad's
// share of the refunded amount computed on the VAT-inclusive total, so a negative credit on Gumroad's account takes back the difference.
// Golden: __fixtures__/refund-vat-exclusive-credit.golden.json (scripts/golden/refund-vat-exclusive-credit.rb), run by the real classes.
// A Braintree sale is not ported (its Gumroad merchant account is another processor's).
import { balanceTransactionBalance, createBalanceTransactionBang, type Amount } from "./balance-transaction.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { rubyRound } from "./concerns/ruby-numeric.ts";
import {
  assignCreditMerchantAccount,
  assignCreditRefund,
  assignCreditUser,
  Credits,
  type CreditRecord,
} from "./credit.ts";
import { gumroadMerchantAccountFor } from "./merchant-account.ts";
import { STRIPE_PROCESSOR } from "./purchase-charge-facts.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { sellerOf } from "./purchase-reloaded-associations.ts";
import type { RefundRecord } from "./refund.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { NotPortedError } from "./user.ts";

const USD = "usd";
const BALANCE = { name: "balance", foreignKey: "balance_id", targetTable: "balances", targetModel: "Balance" } as const;

// The credit's amount: the Gumroad share the refund should have returned, less the share it returned. Null where Ruby returns nil.
export function vatExclusiveRefundCreditCents(
  purchase: {
    feeCents: number;
    affiliateCreditCents: number;
    gumroadTaxCents: number;
    totalTransactionCents: number;
    priceCents: number;
  },
  refund: { totalTransactionCents: number; gumroadTaxCents: number },
): number | null {
  // Only when VAT was charged and this refund returned none of it
  if (refund.gumroadTaxCents > 0 || purchase.gumroadTaxCents === 0) return null;
  const refundedTotal = refund.totalTransactionCents;
  const gumroadAmount = purchase.feeCents + purchase.affiliateCreditCents + purchase.gumroadTaxCents;
  const gumroadAmountSansVat = gumroadAmount - purchase.gumroadTaxCents;
  const refundedGumroadAmount = gumroadAmount * (refundedTotal / purchase.totalTransactionCents);
  const expectedRefundedGumroadAmount = gumroadAmountSansVat * (refundedTotal / purchase.priceCents);
  return rubyRound(expectedRefundedGumroadAmount - refundedGumroadAmount);
}

// `refund` has been appended to `purchase`. Returns null where Ruby returns nil.
export async function createForVatExclusiveRefundBang(
  purchase: PurchaseRecord,
  refund: RefundRecord,
  options: SaveOptions = {},
): Promise<CreditRecord | null> {
  const amountCents = vatExclusiveRefundCreditCents(
    {
      feeCents: purchase.get("fee_cents")!,
      affiliateCreditCents: purchase.get("affiliate_credit_cents")!,
      gumroadTaxCents: purchase.get("gumroad_tax_cents")!,
      totalTransactionCents: purchase.get("total_transaction_cents")!,
      priceCents: purchase.get("price_cents")!,
    },
    {
      totalTransactionCents: refund.get("total_transaction_cents")!,
      gumroadTaxCents: refund.get("gumroad_tax_cents")!,
    },
  );
  if (amountCents === null) return null;
  if (purchase.get("charge_processor_id") !== STRIPE_PROCESSOR)
    throw new NotPortedError(
      "Credit.create_for_vat_exclusive_refund! for a Braintree sale",
      "app/models/credit.rb:175",
    );

  const seller = await sellerOf(purchase);
  const credit = Credits.build({});
  assignCreditUser(credit, seller);
  const merchantAccount = await gumroadMerchantAccountFor(STRIPE_PROCESSOR);
  assignCreditMerchantAccount(credit, merchantAccount);
  credit.set("amount_cents", amountCents);
  assignCreditRefund(credit, refund);
  await Credits.saveBang(credit, options);

  const amount: Amount = { currency: USD, grossCents: amountCents, netCents: amountCents };
  const balanceTransaction = await createBalanceTransactionBang(
    { user: seller, merchantAccount: merchantAccount!, credit, issuedAmount: amount, holdingAmount: amount },
    options,
  );
  assignBelongsTo(credit, BALANCE, await balanceTransactionBalance(balanceTransaction));
  await Credits.saveBang(credit, options);
  return credit;
}
