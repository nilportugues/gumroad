// The arithmetic of a refund, from Purchase::Refundable (app/modules/purchase/refundable.rb: refund!, build_refund and its three
// builders, the flags refund_purchase! sets) and Purchase#decrement_balance_for_refund_or_chargeback! (app/models/purchase.rb) for a
// sale with no collaborator. Pure: the caller reads the sale, its effective refunds and its affiliate credit and writes whatever this
// returns. Golden: __fixtures__/refund-ledger.golden.json (nextjs/scripts/golden/refund-ledger.rb).
//
// Not here, because no recording or golden pins it yet: a buyer-currency (presentment) refund, a sale in another currency than USD,
// a collaborator that also credits a direct affiliate, a chargeback (`dispute`), and every write.

export type RefundSale = {
  price_cents: number;
  total_transaction_cents: number;
  fee_cents: number;
  tax_cents: number;
  gumroad_tax_cents: number;
  affiliate_credit_cents: number;
  // The persisted value (`stripe_partially_refunded_was`); null is a column never set.
  stripe_partially_refunded: boolean | null;
};

export type RefundRow = {
  total_transaction_cents: number;
  amount_cents: number;
  fee_cents: number;
  creator_tax_cents: number;
  gumroad_tax_cents: number;
  status: string | null;
  balance_reversed_on_failure: boolean;
};

export type RefundDraft = {
  total_transaction_cents: number;
  amount_cents: number;
  fee_cents: number;
  creator_tax_cents: number;
  gumroad_tax_cents: number;
  refunding_user_id: number;
};

export type AffiliateCredit = { amount_cents: number; fee_cents: number; basis_points: number };

// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];

// Refund#effective?, the in-memory mirror of the `effective` scope: money that actually left.
export const isEffectiveRefund = (row: Pick<RefundRow, "status" | "balance_reversed_on_failure">): boolean =>
  !TERMINAL_FAILURE_STATUSES.includes(row.status ?? "") || !row.balance_reversed_on_failure;

export type EffectiveSums = {
  total_transaction_cents: number;
  amount_cents: number;
  fee_cents: number;
  creator_tax_cents: number;
  gumroad_tax_cents: number;
};

// `refunds.effective.select(SUM(...))` (SQL SUM skips NULL).
export function effectiveSums(rows: readonly RefundRow[]): EffectiveSums {
  const sums: EffectiveSums = {
    total_transaction_cents: 0,
    amount_cents: 0,
    fee_cents: 0,
    creator_tax_cents: 0,
    gumroad_tax_cents: 0,
  };
  for (const row of rows.filter(isEffectiveRefund)) {
    sums.total_transaction_cents += row.total_transaction_cents ?? 0;
    sums.amount_cents += row.amount_cents ?? 0;
    sums.fee_cents += row.fee_cents ?? 0;
    sums.creator_tax_cents += row.creator_tax_cents ?? 0;
    sums.gumroad_tax_cents += row.gumroad_tax_cents ?? 0;
  }
  return sums;
}

// Purchase#amount_refundable_cents (a USD sale of a processor that is still supported)
export const amountRefundableCents = (sale: RefundSale, sums: EffectiveSums): number =>
  sale.price_cents - sums.amount_cents;
// Purchase#gumroad_tax_refundable_cents
export const gumroadTaxRefundableCents = (sale: RefundSale, sums: EffectiveSums): number =>
  sale.gumroad_tax_cents - sums.gumroad_tax_cents;
// Purchase#gross_amount_refundable_cents
export const grossAmountRefundableCents = (sale: RefundSale, sums: EffectiveSums): number =>
  amountRefundableCents(sale, sums) + gumroadTaxRefundableCents(sale, sums);
// Purchase#gross_amount_refunded_cents
export const grossAmountRefundedCents = (sums: EffectiveSums): number => sums.amount_cents + sums.gumroad_tax_cents;

export type RefundFlags = { stripe_refunded: boolean; stripe_partially_refunded: boolean };

// refund_purchase!: `stripe_refunded = (gross_amount_refunded_cents + funds_refunded) >= total_transaction_cents`
export function refundFlags(sale: RefundSale, sums: EffectiveSums, fundsRefundedCents: number): RefundFlags {
  const stripeRefunded = grossAmountRefundedCents(sums) + fundsRefundedCents >= sale.total_transaction_cents;
  return { stripe_refunded: stripeRefunded, stripe_partially_refunded: !stripeRefunded };
}

// Purchase#partial_refund_amount_acceptable?
const partialRefundAmountAcceptable = (sale: RefundSale, sums: EffectiveSums, grossCents: number): boolean =>
  grossCents > 0 && grossCents <= grossAmountRefundableCents(sale, sums);

// Purchase#build_refund. `flags` are the ones refundFlags returned for this refund.
export function buildRefund(args: {
  sale: RefundSale;
  sums: EffectiveSums;
  flags: RefundFlags;
  grossRefundAmount: number;
  refundingUserId: number;
}): RefundDraft | null {
  const { sale, sums, flags, grossRefundAmount, refundingUserId } = args;
  if (sale.stripe_partially_refunded === true && flags.stripe_refunded) {
    // build_partial_full_refund: whatever is left, unless it went negative.
    const draft: RefundDraft = {
      total_transaction_cents: sale.total_transaction_cents - sums.total_transaction_cents,
      amount_cents: sale.price_cents - sums.amount_cents,
      fee_cents: sale.fee_cents - sums.fee_cents,
      creator_tax_cents: sale.tax_cents - sums.creator_tax_cents,
      gumroad_tax_cents: sale.gumroad_tax_cents - sums.gumroad_tax_cents,
      refunding_user_id: refundingUserId,
    };
    return draft.total_transaction_cents < 0 || draft.amount_cents < 0 ? null : draft;
  }
  if (grossRefundAmount === sale.total_transaction_cents) {
    // build_full_refund
    return {
      total_transaction_cents: sale.total_transaction_cents,
      amount_cents: sale.price_cents,
      creator_tax_cents: sale.tax_cents,
      fee_cents: sale.fee_cents,
      gumroad_tax_cents: gumroadTaxRefundableCents(sale, sums),
      refunding_user_id: refundingUserId,
    };
  }
  // build_partial_refund
  if (!partialRefundAmountAcceptable(sale, sums, grossRefundAmount)) return null;
  let creatorTaxRefunded = 0;
  let gumroadTaxRefunded = 0;
  let refundAmountCents = grossRefundAmount;
  const gumroadResponsibleForTax = sale.gumroad_tax_cents > 0;
  if (gumroadResponsibleForTax && gumroadTaxRefundableCents(sale, sums) > 0) {
    const taxRate = sale.gumroad_tax_cents / sale.total_transaction_cents;
    const taxRefundAmount = Math.floor(grossRefundAmount * taxRate);
    gumroadTaxRefunded = Math.min(taxRefundAmount, gumroadTaxRefundableCents(sale, sums));
    refundAmountCents = grossRefundAmount - gumroadTaxRefunded;
  }
  if (!gumroadResponsibleForTax && sale.tax_cents > 0) {
    const taxRate = sale.tax_cents / sale.total_transaction_cents;
    creatorTaxRefunded = Math.floor(grossRefundAmount * taxRate);
  }
  return {
    total_transaction_cents: grossRefundAmount,
    amount_cents: refundAmountCents,
    fee_cents: Math.floor((sale.fee_cents / sale.price_cents) * refundAmountCents),
    creator_tax_cents: creatorTaxRefunded,
    gumroad_tax_cents: gumroadTaxRefunded,
    refunding_user_id: refundingUserId,
  };
}

export type RefundChoice =
  | { kind: "too_large" }
  // refund_and_save!(user) with no amount: refund what the charge can still give back.
  | { kind: "full" }
  | { kind: "partial"; amount_cents: number };

export const AMOUNT_TOO_LARGE = "Refund amount cannot be greater than the purchase price.";

// `String#to_d` then `(amount * 100).to_i` for a USD sale, which truncates toward zero. Only plain decimals are read; anything
// BigDecimal would parse differently (an exponent, a leading dot, separators) is refused rather than guessed.
export function usdAmountToCents(amount: string): number | null {
  const match = /^\s*([+-]?)(\d+)(?:\.(\d*))?\s*$/u.exec(amount);
  if (!match) return null;
  const fraction = `${match[3] ?? ""}00`.slice(0, 2);
  const cents = Number(match[2]) * 100 + Number(fraction);
  return match[1] === "-" ? -cents : cents;
}

// Purchase::Refundable#refund! (`amount.blank?`, the refundable ceiling, and the two short-circuits to a full refund)
export function chooseRefund(
  sale: RefundSale,
  sums: EffectiveSums,
  amount: string | null | undefined,
): RefundChoice | null {
  if (amount === null || amount === undefined || amount.trim() === "") return { kind: "full" };
  const cents = usdAmountToCents(amount);
  if (cents === null) return null;
  const refundable = amountRefundableCents(sale, sums);
  if (cents > refundable) return { kind: "too_large" };
  if (cents === sale.price_cents || cents === refundable) return { kind: "full" };
  return { kind: "partial", amount_cents: cents };
}

export type BalanceWrite =
  | { writer: "affiliate"; refund_cents: number; fee_cents: number }
  | { writer: "seller"; refund_cents: number };

// Purchase#decrement_balance_for_refund_or_chargeback! for a refund: the affiliate's reversal, then the seller's, in the order Ruby
// writes them. A write of zero is skipped by the writers themselves, so it is left out here.
export function balanceWrites(sale: RefundSale, credit: AffiliateCredit | null, refund: RefundDraft): BalanceWrite[] {
  let sellerRefundCents: number;
  let affiliateRefundCents: number;
  let affiliateRefundFeeCents: number;
  if ([sale.price_cents, sale.total_transaction_cents].includes(refund.amount_cents)) {
    // payment_cents = price_cents - fee_cents
    sellerRefundCents = sale.price_cents - sale.fee_cents - sale.affiliate_credit_cents;
    affiliateRefundCents = sale.affiliate_credit_cents;
    affiliateRefundFeeCents = credit?.fee_cents ?? 0;
  } else {
    const decrementAmountCents = refund.amount_cents;
    const refundedFeeCents = refund.fee_cents;
    sellerRefundCents = decrementAmountCents - refundedFeeCents;
    if (sale.affiliate_credit_cents === 0) {
      affiliateRefundCents = 0;
      affiliateRefundFeeCents = 0;
    } else {
      // affiliate_reversal_amounts, for a credit that is not a collaborator's
      const share = credit!.basis_points / 10_000.0;
      affiliateRefundFeeCents = credit!.fee_cents === 0 ? 0 : Math.floor(share * refundedFeeCents);
      affiliateRefundCents = Math.ceil(share * decrementAmountCents) - affiliateRefundFeeCents;
      sellerRefundCents = sellerRefundCents - affiliateRefundCents - affiliateRefundFeeCents;
    }
  }
  const writes: BalanceWrite[] = [];
  // process_refund_or_chargeback_for_affiliate_credit_balance: `return if total_credit_cents == 0 || refund_cents == 0`
  if (sale.affiliate_credit_cents !== 0 && affiliateRefundCents !== 0) {
    writes.push({ writer: "affiliate", refund_cents: affiliateRefundCents, fee_cents: affiliateRefundFeeCents });
  }
  if (sellerRefundCents !== 0) writes.push({ writer: "seller", refund_cents: sellerRefundCents });
  return writes;
}
