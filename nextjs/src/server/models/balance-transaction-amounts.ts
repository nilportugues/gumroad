// BalanceTransaction::Amount (app/models/balance_transaction.rb): the issued and holding amounts a seller's sale or an
// affiliate's credit books. Pure over the flow of funds a charge produced (stripe-charge-facts.ts).
// Golden: __fixtures__/balance-transaction-amounts.golden.json (scripts/golden/balance-transaction-amounts.rb).
import type { Amount } from "./balance-transaction.ts";
import type { FlowAmount, FlowOfFunds } from "./stripe-charge-facts.ts";

// A flow of funds whose settled amount may be missing (Ruby tolerates a nil one in the buyer-presentment branch).
export type SellerFlowOfFunds = Omit<FlowOfFunds, "settledAmount"> & { settledAmount: FlowAmount | null };

// Currency::USD
const USD = "usd";

const toAmount = (currency: string, grossCents: number, netCents: number): Amount => ({
  currency,
  grossCents,
  netCents,
});

// create_issued_amount_for_affiliate / create_holding_amount_for_affiliate: canonical USD whatever the charge, unless a reversal
// follows the label of the ledger it offsets.
export function affiliateAmount(issuedAffiliateCents: number, currency: string = USD): Amount {
  return toAmount(currency, issuedAffiliateCents, issuedAffiliateCents);
}

// create_issued_amount_for_seller
export function issuedAmountForSeller(facts: {
  flowOfFunds: SellerFlowOfFunds;
  issuedNetCents: number;
  canonicalIssuedAmount?: FlowAmount | null;
}): Amount {
  const gross = facts.canonicalIssuedAmount ?? facts.flowOfFunds.issuedAmount;
  return toAmount(gross.currency, gross.cents, facts.issuedNetCents);
}

// The issued and holding amounts Purchase#increment_sellers_balance! books for a sale.
export function balanceTransactionAmountsForSale(facts: {
  flowOfFunds: SellerFlowOfFunds;
  issuedNetCents: number;
  canonicalIssuedAmount: FlowAmount | null;
  gumroadHeld: boolean;
}): { issued: Amount; holding: Amount } {
  return { issued: issuedAmountForSeller(facts), holding: holdingAmountForSeller(facts) };
}

// create_holding_amount_for_seller. `gumroadHeld` is `merchant_account.holder_of_funds == HolderOfFunds::GUMROAD`, false when the
// caller has no merchant account.
export function holdingAmountForSeller(facts: {
  flowOfFunds: SellerFlowOfFunds;
  issuedNetCents: number;
  canonicalIssuedAmount?: FlowAmount | null;
  gumroadHeld: boolean;
}): Amount {
  const { flowOfFunds } = facts;
  if (flowOfFunds.merchantAccountGrossAmount !== null) {
    return toAmount(
      flowOfFunds.merchantAccountGrossAmount.currency,
      flowOfFunds.merchantAccountGrossAmount.cents,
      flowOfFunds.merchantAccountNetAmount!.cents,
    );
  }
  const canonical = facts.canonicalIssuedAmount ?? null;
  // A buyer-presentment charge into a seller's own connected account is labelled with the currency Stripe settled; Gumroad-held
  // funds are always the canonical (USD) liability.
  if (canonical !== null && flowOfFunds.settledAmount !== null && !facts.gumroadHeld) {
    return toAmount(flowOfFunds.settledAmount.currency, flowOfFunds.settledAmount.cents, facts.issuedNetCents);
  }
  const gross = canonical ?? flowOfFunds.issuedAmount;
  return toAmount(gross.currency, gross.cents, facts.issuedNetCents);
}
