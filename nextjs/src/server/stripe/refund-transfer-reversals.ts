// Port of the two transfer reversals Purchase::Refundable makes inside the refund's transaction (app/modules/purchase/refundable.rb):
// reverse_excess_amount_from_stripe_transfer (VAT that was refunded on its own is taken back from the seller's transfer) and
// reverse_the_transfer_made_for_dispute_win! (a refund after a won dispute takes back the seller's share of the transfer Stripe made when
// the dispute was won). Stripe is `RefundStripe` (refund-fee-collection.ts); the rows are the caller's. Golden:
// __fixtures__/refund-fee-retention.golden.json (`excess`, `dispute`; scripts/golden/refund-fee-retention.rb).
//
// Not served yet: the transaction around both (the Refund insert and the seller's balance transaction) is still Rails'. A reversal list
// with `has_more` is refused (NotPortedError) rather than paged.
import { NotPortedError } from "../models/user.ts";
import { InvalidRequestError } from "./errors.ts";
import type { RefundStripe, StripeList, StripeReversal, StripeTransfer } from "./refund-fee-collection.ts";

const USD = "usd";
// StripeChargeProcessor::EXTERNAL_REFUND_REVERSAL_METADATA_KEY
const EXTERNAL_REFUND_REVERSAL_METADATA_KEY = "external_refund_id";
const ALREADY_FULLY_REVERSED = /already fully reversed/iu;
// The window before the win in which Stripe may have made the transfer (60,000 seconds).
const DISPUTE_WIN_TRANSFER_WINDOW_SECONDS = 60_000;
const TRANSFER_LIST_LIMIT = 100;

const blank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

export class MissingStripeAttribute extends Error {
  readonly rubyClass = "NoMethodError";
}

// BigDecimal / Rational `#round` of a positive quotient: half away from zero, on integers so nothing is lost to a float.
function roundedQuotient(numerator: number, denominator: number): number {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return Number((2n * n + d) / (2n * d));
}

export type ExcessContext = {
  holderOfFunds: string;
  purchase: { gumroadTaxCents: number; gumroadTaxRefundedCents: number; stripeTransactionId: string };
  merchantAccountId: string;
  refund: { id: number; processorRefundId: string | null };
  // refund.balance_transactions.where(user_id: seller_id).last
  sellerBalanceTransaction: { issuedAmountNetCents: number; holdingAmountNetCents: number; holdingAmountCurrency: string } | null;
  // ErrorNotifier.notify, for a transfer Stripe says is already fully reversed
  notifyAlreadyReversed: (error: Error, transferId: string) => void;
  // Credit.create_for_partial_refund_transfer_reversal!
  createCredit: (credit: { amountCentsUsd: number; amountCentsHoldingCurrency: number }) => Promise<void>;
};

// Purchase#reverse_excess_amount_from_stripe_transfer(refund:)
export async function reverseExcessAmountFromStripeTransfer(stripe: RefundStripe, context: ExcessContext): Promise<void> {
  const { purchase, refund } = context;
  if (context.holderOfFunds !== "stripe") return;
  if (!(purchase.gumroadTaxCents > 0 && purchase.gumroadTaxRefundedCents === purchase.gumroadTaxCents)) return;

  // The refund's balance transaction holds the same money in both denominations; the leg that matches the transfer's currency is the
  // one to send, never the canonical USD figure against a transfer in another currency.
  const balanceTransaction = context.sellerBalanceTransaction;
  if (balanceTransaction === null) return;

  const charge = (await stripe.call({ call: "Charge.retrieve", id: purchase.stripeTransactionId })) as { transfer: string };
  const transfer = (await stripe.call({ call: "Transfer.retrieve", params: { id: charge.transfer } })) as StripeTransfer;
  const transferCurrency = transfer.currency.toLowerCase();

  let amountToReverseCents: number | null = null;
  if (transferCurrency === USD) amountToReverseCents = Math.abs(balanceTransaction.issuedAmountNetCents);
  else if (transferCurrency === balanceTransaction.holdingAmountCurrency.toLowerCase())
    amountToReverseCents = Math.abs(balanceTransaction.holdingAmountNetCents);
  // Neither leg is in the transfer's currency: any number sent would be a guess at the seller's expense.
  if (amountToReverseCents === null) return;
  if (!(amountToReverseCents > 0)) return;

  const reversals = transfer.reversals ?? { data: [] };
  if (reversals.has_more) throw new NotPortedError("Transfer reversals past the first page", "refundable.rb: each_refund_fee_reversal");
  const existingReversal = reversals.data.find((reversal) => {
    if (!("source_refund" in reversal)) throw new MissingStripeAttribute("undefined method 'source_refund' for an instance of Stripe::StripeObject");
    return reversal.source_refund === refund.processorRefundId || externalRefundReversalFor(reversal, refund.processorRefundId);
  });
  const amountAlreadyReversedCents = existingReversal?.amount === undefined || existingReversal.amount === null ? 0 : Math.abs(existingReversal.amount);
  if (!(amountAlreadyReversedCents < amountToReverseCents)) return;

  // Reversals not tied to this refund still consume what the transfer can give back.
  const transferCentsAvailableToReverse = (transfer.amount ?? 0) - (transfer.amount_reversed ?? 0);
  const reversalAmountCents = Math.min(amountToReverseCents - amountAlreadyReversedCents, transferCentsAvailableToReverse);
  if (!(reversalAmountCents > 0)) return;

  // The ledger stays in USD whatever the transfer's currency; a partial reversal takes the same proportion of the canonical leg.
  const canonicalAmountCents = Math.abs(balanceTransaction.issuedAmountNetCents);
  const reversalAmountUsdCents =
    reversalAmountCents === amountToReverseCents ? canonicalAmountCents : roundedQuotient(canonicalAmountCents * reversalAmountCents, amountToReverseCents);

  let transferReversal: StripeReversal;
  try {
    transferReversal = (await stripe.call({ call: "Transfer.create_reversal", id: transfer.id, params: { amount: reversalAmountCents } })) as StripeReversal;
  } catch (error) {
    // Stripe has already taken the refund, so letting this out rolls the refund bookkeeping back; nothing is owed once fully reversed.
    if (!(error instanceof InvalidRequestError) || !ALREADY_FULLY_REVERSED.test(error.message)) throw error;
    context.notifyAlreadyReversed(error, transfer.id);
    return;
  }

  const options = { stripe_account: context.merchantAccountId };
  const destinationRefund = (await stripe.call({ call: "Refund.retrieve", id: transferReversal.destination_payment_refund!, options })) as { balance_transaction: string };
  const destinationBalanceTransaction = (await stripe.call({ call: "BalanceTransaction.retrieve", id: destinationRefund.balance_transaction, options })) as { net: number };
  await context.createCredit({
    amountCentsUsd: negated(reversalAmountUsdCents),
    amountCentsHoldingCurrency: negated(Math.abs(destinationBalanceTransaction.net)),
  });
}

const negated = (cents: number) => (cents === 0 ? 0 : -cents);

// StripeChargeProcessor.external_refund_reversal_for?(reversal, refund_id)
function externalRefundReversalFor(reversal: StripeReversal, refundId: string | null): boolean {
  const { metadata } = reversal;
  // Stripe::StripeObject is never `blank?`, even when empty: an empty metadata still reads "" and matches a blank refund id.
  if (blank(metadata)) return false;
  const value = metadata![EXTERNAL_REFUND_REVERSAL_METADATA_KEY];
  return refundId !== null && (value === undefined || value === null || value === false ? "" : String(value)) === refundId;
}

export type DisputeWinContext = {
  holderOfFunds: string;
  // dispute.won_at.to_i; null when there is no dispute or it was not won
  disputeWonAtSeconds: number | null;
  chargeProcessorDisputeId: string | null;
  merchantAccountId: string;
  // charge.successful_purchases, or the purchase alone
  purchases: { totalTransactionCents: number; gumroadTaxCents: number; stripeRefunded: boolean }[];
  // the effective refunds of those purchases
  refunds: { totalTransactionCents: number; gumroadTaxCents: number; gumroadFunded: boolean; balanceReconciliationNeeded: boolean }[];
  refund: { id: number; processorRefundId: string | null };
};

// Purchase#reverse_the_transfer_made_for_dispute_win!(refund:)
export async function reverseTheTransferMadeForDisputeWin(stripe: RefundStripe, context: DisputeWinContext): Promise<void> {
  if (context.holderOfFunds !== "stripe") return;
  if (context.disputeWonAtSeconds === null) return;

  const transfers = (await stripe.call({
    call: "Transfer.list",
    params: { destination: context.merchantAccountId, created: { gte: context.disputeWonAtSeconds - DISPUTE_WIN_TRANSFER_WINDOW_SECONDS }, limit: TRANSFER_LIST_LIMIT },
  })) as StripeList<StripeTransfer & { description?: string | null }>;
  const marker = `Dispute ${context.chargeProcessorDisputeId} won`;
  const transfer = transfers.data.find((candidate) => candidate.description?.includes(marker));
  if (!transfer) return;

  // The transfer holds the seller's share of the whole charge: reverse the share of every refund that debited the seller, less what is
  // already reversed, so tax-only refunds and refunds that did not debit the seller add nothing and each refund corrects rounding.
  const exempt = context.refunds.filter((refund) => refund.gumroadFunded || refund.balanceReconciliationNeeded);
  const debited = context.refunds.filter((refund) => !(refund.gumroadFunded || refund.balanceReconciliationNeeded));
  const debitedCents = debited.reduce((sum, refund) => sum + refund.totalTransactionCents - refund.gumroadTaxCents, 0);
  const baseCents = context.purchases.reduce((sum, purchase) => sum + purchase.totalTransactionCents - purchase.gumroadTaxCents, 0);
  if (!(baseCents > 0)) return;

  const target =
    exempt.length === 0 && context.purchases.every((purchase) => purchase.stripeRefunded)
      ? transfer.amount
      : Math.min(roundedQuotient(transfer.amount * debitedCents, baseCents), transfer.amount);
  const amount = target - (transfer.amount_reversed ?? 0);
  if (!(amount > 0)) return;

  await stripe.call({
    call: "Transfer.create_reversal",
    id: transfer.id,
    params: { amount },
    options: { idempotency_key: `dispute_win_reversal_${context.refund.processorRefundId ?? context.refund.id}` },
  });
}
