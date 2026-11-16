// Port of the arithmetic of Credit.create_for_refund_fee_retention! (app/models/credit.rb): the credit that keeps the processor fee (and,
// for a Stripe Connect sale, the application fee) from a refunded sale, the retained fee the refund records, whether its collection from
// Stripe is still pending, and the amounts of the balance transaction booked with it. Pure: the rows are the caller's to write.
// Golden: stripe/__fixtures__/refund-fee-retention.golden.json (`retention`; scripts/golden/refund-fee-retention.rb).
import { rubyRound } from "./concerns/ruby-numeric.ts";
import { PROCESSOR_FEE_PER_THOUSAND, PROCESSOR_FIXED_FEE_CENTS } from "./purchase-fees.ts";
import type { Amount } from "./balance-transaction.ts";

const USD = "usd";
const PER_THOUSAND = 1000;

export type RetentionInput = {
  sale: {
    priceCents: number;
    processorFeeCents: number | null;
    processorFeeCentsCurrency: string | null;
    gumroadTaxCents: number;
    affiliateCreditCents: number;
  };
  refundAmountCents: number;
  // purchase.charged_using_gumroad_merchant_account?
  chargedUsingGumroadMerchantAccount: boolean;
  // merchant_account.holder_of_funds ("stripe" for a Gumroad-managed account, "gumroad" for Gumroad's own)
  holderOfFunds: string;
  merchantCurrency: string;
  // credit.usd_cents_to_currency
  usdCentsToCurrency: (currency: string, cents: number) => Promise<number>;
};

export type Retention = {
  creditAmountCents: number;
  // The credit sits on Gumroad's own merchant account (a Connect sale) or the sale's (a Gumroad-managed one).
  creditMerchantAccount: "gumroad" | "sale";
  // refund.retained_fee_cents: only the Gumroad-managed branch records it.
  retainedFeeCents: number | null;
  // refund.fee_retention_pending: the collection from Stripe waits for the transaction to commit.
  feeRetentionPending: boolean | null;
  issuedAmount: Amount;
  holdingAmount: Amount;
};

// Integer#-@ has no negative zero.
const negated = (cents: number) => (cents === 0 ? 0 : -cents);
const amount = (currency: string, cents: number): Amount => ({ currency, grossCents: cents, netCents: cents });

// Credit.create_for_refund_fee_retention!(refund:); null where Ruby returns nil (a Connect sale with no Gumroad tax or affiliate credit).
export async function refundFeeRetention(input: RetentionInput): Promise<Retention | null> {
  const { sale, refundAmountCents } = input;
  if (!input.chargedUsingGumroadMerchantAccount) {
    // For Stripe Connect sales the application fee covers Gumroad's fee, the VAT and the affiliate credit; the seller is credited what the
    // refund takes back because Gumroad has no balance of theirs to debit.
    const applicationFeeRefundablePortion = sale.gumroadTaxCents + sale.affiliateCreditCents;
    if (applicationFeeRefundablePortion === 0) return null;
    const creditAmountCents = rubyRound(applicationFeeRefundablePortion * (refundAmountCents / sale.priceCents));
    const usd = amount(USD, creditAmountCents);
    return {
      creditAmountCents,
      creditMerchantAccount: "gumroad",
      retainedFeeCents: null,
      feeRetentionPending: null,
      issuedAmount: usd,
      holdingAmount: usd,
    };
  }

  const creditAmountCents =
    sale.processorFeeCents !== null && sale.processorFeeCentsCurrency === USD
      ? negated(rubyRound(sale.processorFeeCents * (refundAmountCents / sale.priceCents)))
      : negated(rubyRound((refundAmountCents * PROCESSOR_FEE_PER_THOUSAND) / PER_THOUSAND + (PROCESSOR_FIXED_FEE_CENTS * refundAmountCents) / sale.priceCents));
  const holdingCents = await input.usdCentsToCurrency(input.merchantCurrency, creditAmountCents);
  return {
    creditAmountCents,
    creditMerchantAccount: "sale",
    retainedFeeCents: Math.abs(creditAmountCents),
    feeRetentionPending: input.holderOfFunds === "stripe" ? creditAmountCents !== 0 : null,
    issuedAmount: amount(USD, creditAmountCents),
    holdingAmount: amount(input.merchantCurrency, holdingCents),
  };
}
