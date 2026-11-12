// Purchase#decrement_balance_for_refund_or_chargeback! for a refund (app/models/purchase.rb): what the refund takes back from the
// affiliates a sale credited (their refund BalanceTransaction, the credit's refund balance, the AffiliatePartialRefund of a partial
// reversal), then the seller's share (refund-seller-balance.ts), in the order Ruby writes them. That covers a lone affiliate or
// collaborator and a collaborator beside a direct affiliate.
// Golden: __fixtures__/refund-affiliate-balance.golden.json (scripts/golden/refund-affiliate-balance.rb), run by the real class.
//
// Not served by any route. Every refusal is a NotPortedError raised before the first write of the call, except the currency labels
// of a later credit, which Ruby reads only after the first credit is written: the caller's transaction (refund_purchase!'s) rolls
// that back. Refused: a chargeback balance, a sale charged on the seller's own Connect account, an affiliate credit row that is
// missing, a balance held in another currency than USD, and a direct affiliate rate that was never stored on the purchase.
import type { AffiliateCredit } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { AffiliatePartialRefunds, PARTIAL_REFUND_ASSOCIATIONS } from "./affiliate-partial-refund.ts";
import { affiliateAmount, type SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import { balanceTransactionBalance, createBalanceTransactionBang } from "./balance-transaction.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { loadBelongsTo, setAssociation, type BelongsTo } from "./concerns/rails-validations.ts";
import { gumroadMerchantAccountFor } from "./merchant-account.ts";
import {
  AFFILIATE_CREDITS,
  AFFILIATE_USER,
  AffiliateCredits,
  jsonDataOf,
  hasDirectAffiliateId,
  readAffiliate,
  readDirectAffiliate,
  type AffiliateCreditRecord,
} from "./purchase-affiliate-credit.ts";
import { chargedUsingGumroadMerchantAccount, type ChargeMerchantAccount } from "./purchase-charge-facts.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { sellerOf } from "./purchase-reloaded-associations.ts";
import { processRefundForPurchaseBalanceBang } from "./refund-seller-balance.ts";
import type { RefundRecord } from "./refund.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, connection, selectRows, table } from "./sql.ts";
import { NotPortedError, Users } from "./user.ts";

const COLLABORATOR = "Collaborator";
const USD = "usd";
const BASIS_POINTS_PER_UNIT = 10_000.0;

const notPorted = (what: string) =>
  new NotPortedError(
    `Purchase#decrement_balance_for_refund_or_chargeback! with ${what}`,
    "app/models/purchase.rb:2822",
  );

const BALANCES = "balances";
const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};
const PURCHASE_REFUND_BALANCE: BelongsTo = {
  name: "purchase_refund_balance",
  foreignKey: "purchase_refund_balance_id",
  targetTable: BALANCES,
  targetModel: "Balance",
};
const CREDIT_REFUND_BALANCE: BelongsTo = {
  name: "affiliate_credit_refund_balance",
  foreignKey: "affiliate_credit_refund_balance_id",
  targetTable: BALANCES,
  targetModel: "Balance",
};

type Reversal = { credit: AffiliateCreditRecord; amountCents: number; feeCents: number };

// One decrement: what Ruby memoizes on the purchase instance (the affiliate lookups and the has_one credits).
class Decrement {
  #creditsDirectAffiliate: boolean | undefined;
  readonly #credits = new Map<boolean, AffiliateCreditRecord | null>();
  #chargedOnGumroad: boolean | undefined;

  constructor(
    readonly purchase: PurchaseRecord,
    readonly refund: RefundRecord,
    readonly options: SaveOptions,
  ) {}

  // credits_direct_affiliate?: a direct affiliate id, a collaborator affiliate and the direct affiliate found
  async creditsDirectAffiliate(): Promise<boolean> {
    if (this.#creditsDirectAffiliate !== undefined) return this.#creditsDirectAffiliate;
    let result = false;
    if (hasDirectAffiliateId(this.purchase)) {
      const affiliateId = this.purchase.get("affiliate_id");
      const affiliate = affiliateId == null ? null : await readAffiliate(affiliateId);
      if (affiliate !== null && affiliate.type === COLLABORATOR)
        result = (await readDirectAffiliate(jsonDataOf(this.purchase).direct_affiliate_id as number)) !== null;
    }
    this.#creditsDirectAffiliate = result;
    return result;
  }

  // `affiliate_credit` / `direct_affiliate_credit` (has_one, read once per purchase)
  async credit(direct: boolean): Promise<AffiliateCreditRecord | null> {
    if (this.#credits.has(direct)) return this.#credits.get(direct)!;
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`affiliate_credits`.*")} FROM ${table(AFFILIATE_CREDITS)} WHERE ${column(AFFILIATE_CREDITS, "purchase_id")} = ${this.purchase.get("id")} AND ${column(AFFILIATE_CREDITS, "is_direct_affiliate_credit")} = ${direct ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} LIMIT 1`,
    );
    let credit: AffiliateCreditRecord | null = null;
    if (row) {
      credit = AffiliateCredits.load(castRow<AffiliateCredit>("AffiliateCredit", row));
      // has_one's inverse: the credit's purchase is this instance
      setAssociation(credit, "purchase", credit.get("purchase_id"), this.purchase.attributes as never);
    }
    this.#credits.set(direct, credit);
    return credit;
  }

  // charged_using_gumroad_merchant_account?, the first read of the purchase's merchant account
  async chargedOnGumroad(): Promise<boolean> {
    if (this.#chargedOnGumroad !== undefined) return this.#chargedOnGumroad;
    const account = (await loadBelongsTo(this.purchase, MERCHANT_ACCOUNT, {
      tx: (await connection()) as never,
    })) as ChargeMerchantAccount | null;
    this.#chargedOnGumroad = chargedUsingGumroadMerchantAccount(account, this.purchase.get("charge_processor_id"));
    return this.#chargedOnGumroad;
  }

  // direct_affiliate_price_share: the rate stored on the purchase when it was credited
  directAffiliatePriceShare(): number {
    const stored = jsonDataOf(this.purchase).direct_affiliate_basis_points;
    if (stored === undefined || stored === null)
      throw notPorted("a direct affiliate rate that is not stored on the purchase");
    return Number(stored) / BASIS_POINTS_PER_UNIT;
  }

  // affiliate_reversal_share
  async reversalShare(credit: AffiliateCreditRecord): Promise<number> {
    const share = Number(credit.get("basis_points")) / BASIS_POINTS_PER_UNIT;
    if (!(await this.creditsDirectAffiliate()) || credit.get("is_direct_affiliate_credit")) return share;
    return share * (1 - this.directAffiliatePriceShare());
  }

  // affiliate_reversal_fee_cents
  async reversalFeeCents(credit: AffiliateCreditRecord, refundedFeeCents: number): Promise<number> {
    const creditFee = Number(credit.get("fee_cents") ?? 0);
    if (creditFee === 0) return 0;
    const fee = this.purchase.get("fee_cents") ?? 0;
    if ((await this.creditsDirectAffiliate()) && fee > 0) return Math.floor((creditFee * refundedFeeCents) / fee);
    return Math.floor((await this.reversalShare(credit)) * refundedFeeCents);
  }

  // affiliate_reversal_amounts: [affiliate cents, fee cents]
  async reversalAmounts(credit: AffiliateCreditRecord | null, decrementCents: number, refundedFeeCents: number) {
    if (credit === null) throw notPorted("an affiliate credit with no credit row");
    const feeCents = await this.reversalFeeCents(credit, refundedFeeCents);
    return [Math.ceil((await this.reversalShare(credit)) * decrementCents) - feeCents, feeCents] as const;
  }

  // affiliate_reversal_currencies: the labels of the ledger the credit's success balance sits on
  async reversalCurrencies(credit: AffiliateCreditRecord): Promise<readonly [string, string]> {
    const [ids] = await selectRows(
      Prisma.sql`SELECT ${column(AFFILIATE_CREDITS, "affiliate_credit_success_balance_id")}, ${column(AFFILIATE_CREDITS, "affiliate_credit_chargeback_balance_id")} FROM ${table(AFFILIATE_CREDITS)} WHERE ${column(AFFILIATE_CREDITS, "id")} = ${credit.get("id")} LIMIT 1`,
    );
    const successId = ids?.affiliate_credit_success_balance_id as bigint | number | null | undefined;
    if (successId == null) throw notPorted("an affiliate credit that has no success balance");
    const [balance] = await selectRows(
      Prisma.sql`SELECT ${column(BALANCES, "merchant_account_id")}, ${column(BALANCES, "currency")}, ${column(BALANCES, "holding_currency")} FROM ${table(BALANCES)} WHERE ${column(BALANCES, "id")} = ${successId} LIMIT 1`,
    );
    const merchantAccountId = balance?.merchant_account_id as bigint | number | null | undefined;
    if (merchantAccountId == null) return [USD, USD];
    const processor = this.purchase.get("charge_processor_id");
    const account = processor == null ? null : await gumroadMerchantAccountFor(processor);
    if (account === null || Number(account.get("id")) !== Number(merchantAccountId)) return [USD, USD];
    const labels = [String(balance!.currency), String(balance!.holding_currency)] as const;
    if (labels[0] !== USD || labels[1] !== USD) throw notPorted("an affiliate balance held in another currency");
    return labels;
  }

  // process_refund_or_chargeback_for_affiliate_credit_balance
  async reverseCredit(refundCents: number, feeCents: number, credit: AffiliateCreditRecord | null): Promise<void> {
    credit ??= await this.credit(false);
    // A collab purchase that also credits a direct affiliate keeps both credits in affiliate_credit_cents.
    const totalCreditCents = (await this.creditsDirectAffiliate())
      ? Number(credit?.get("amount_cents") ?? 0)
      : (this.purchase.get("affiliate_credit_cents") ?? 0);
    if (totalCreditCents === 0 || refundCents === 0) return;
    if (credit === null) throw notPorted("an affiliate credit with no credit row");

    const [issuedCurrency, holdingCurrency] = await this.reversalCurrencies(credit);
    const affiliateUserRow = await loadBelongsTo(credit, AFFILIATE_USER, { tx: (await connection()) as never });
    if (affiliateUserRow === null) throw notPorted("an affiliate credit whose user no longer exists");
    const processor = this.purchase.get("charge_processor_id");
    const merchantAccount = processor == null ? null : await gumroadMerchantAccountFor(processor);
    if (merchantAccount === null) throw notPorted("no Gumroad merchant account");
    // update_user_balance_in_transaction_for_affiliate: only a charge on Gumroad's account is served
    if (!(await this.chargedOnGumroad())) throw notPorted("a seller's own Connect account");

    const transaction = await createBalanceTransactionBang(
      {
        user: Users.load(affiliateUserRow as never),
        merchantAccount,
        refund: this.refund,
        issuedAmount: affiliateAmount(-1 * refundCents, issuedCurrency),
        holdingAmount: affiliateAmount(-1 * refundCents, holdingCurrency),
      },
      this.options,
    );
    const balance = await balanceTransactionBalance(transaction);
    assignBelongsTo(credit, CREDIT_REFUND_BALANCE, balance);
    await AffiliateCredits.saveBang(credit, this.options);

    if (totalCreditCents === refundCents) return;
    const affiliateRow = await loadBelongsTo(credit, PARTIAL_REFUND_ASSOCIATIONS.affiliate, {
      tx: (await connection()) as never,
    });
    const partialRefund = AffiliatePartialRefunds.build({
      amount_cents: refundCents,
      purchase_id: Number(this.purchase.get("id")),
      total_credit_cents: totalCreditCents,
      affiliate_user_id: credit.get("affiliate_user_id"),
      seller_id: Number(this.purchase.get("seller_id")),
      affiliate_id: credit.get("affiliate_id"),
      balance_id: balance!.get("id") as number,
      affiliate_credit_id: credit.get("id"),
      fee_cents: BigInt(feeCents),
    });
    const {
      affiliate_user,
      affiliate_credit,
      seller,
      purchase,
      affiliate,
      balance: balanceAssociation,
    } = PARTIAL_REFUND_ASSOCIATIONS;
    for (const [belongsTo, row] of [
      [affiliate_user, affiliateUserRow],
      [affiliate_credit, credit.attributes],
      [seller, (await sellerOf(this.purchase)).attributes],
      [purchase, this.purchase.attributes],
      [affiliate, affiliateRow],
      [balanceAssociation, balance!.attributes],
    ] as const)
      setAssociation(partialRefund, belongsTo.name, partialRefund.get(belongsTo.foreignKey as never), row as never);
    await AffiliatePartialRefunds.saveBang(partialRefund, this.options);
  }
}

// `seller_balance_update_eligible?`: the purchase has no refund balance yet, or this refund is one of several partial ones
async function sellerBalanceUpdateEligible(purchase: PurchaseRecord): Promise<boolean> {
  if (purchase.get("purchase_chargeback_balance_id") != null) throw notPorted("a chargeback balance");
  if (purchase.get("purchase_refund_balance_id") == null) return true;
  const balance = await loadBelongsTo(purchase, PURCHASE_REFUND_BALANCE, { tx: (await connection()) as never });
  return (
    balance === null ||
    purchase.get("stripe_partially_refunded") === true ||
    purchase.attributeWas("stripe_partially_refunded") === true
  );
}

export type RefundDecrementFacts = {
  // The flow of funds the refund produced (StripeChargeRefund#build_flow_of_funds)
  flowOfFunds: SellerFlowOfFunds;
};

// `decrement_balance_for_refund_or_chargeback!(flow_of_funds, refund:)`. `purchase` carries the flags refund_purchase! has set.
export async function decrementBalanceForRefundBang(
  purchase: PurchaseRecord,
  refund: RefundRecord,
  facts: RefundDecrementFacts,
  options: SaveOptions = {},
): Promise<void> {
  if (!(await sellerBalanceUpdateEligible(purchase))) return;
  const run = new Decrement(purchase, refund, options);

  const priceCents = purchase.get("price_cents")!;
  const feeCents = purchase.get("fee_cents")!;
  const affiliateCreditCents = purchase.get("affiliate_credit_cents") ?? 0;
  const refundAmountCents = refund.get("amount_cents")!;
  // Short circuit for a full refund
  const full = [priceCents, purchase.get("total_transaction_cents")].includes(refundAmountCents);
  const paymentCents = priceCents - feeCents;
  const direct = await run.creditsDirectAffiliate();

  let sellerRefundCents: number;
  const reversals: Reversal[] = [];
  if (direct) {
    const credits = [await run.credit(false), await run.credit(true)].filter(
      (credit): credit is AffiliateCreditRecord => credit !== null,
    );
    if (full) {
      sellerRefundCents = paymentCents - affiliateCreditCents;
      for (const credit of credits)
        reversals.push({
          credit,
          amountCents: Number(credit.get("amount_cents") ?? 0),
          feeCents: Number(credit.get("fee_cents") ?? 0),
        });
    } else {
      // partial_affiliate_reversals
      sellerRefundCents = refundAmountCents - refund.get("fee_cents")!;
      for (const credit of credits) {
        const [amountCents, creditFeeCents] = await run.reversalAmounts(
          credit,
          refundAmountCents,
          refund.get("fee_cents")!,
        );
        sellerRefundCents -= amountCents + creditFeeCents;
        reversals.push({ credit, amountCents, feeCents: creditFeeCents });
      }
    }
    for (const reversal of reversals) await run.reverseCredit(reversal.amountCents, reversal.feeCents, reversal.credit);
  } else {
    let affiliateRefundCents: number;
    let affiliateRefundFeeCents: number;
    if (full) {
      sellerRefundCents = paymentCents - affiliateCreditCents;
      affiliateRefundCents = affiliateCreditCents;
      affiliateRefundFeeCents = Number((await run.credit(false))?.get("fee_cents") ?? 0);
    } else {
      const refundedFeeCents = refund.get("fee_cents")!;
      sellerRefundCents = refundAmountCents - refundedFeeCents;
      if (affiliateCreditCents === 0) {
        affiliateRefundCents = 0;
        affiliateRefundFeeCents = 0;
      } else {
        [affiliateRefundCents, affiliateRefundFeeCents] = await run.reversalAmounts(
          await run.credit(false),
          refundAmountCents,
          refundedFeeCents,
        );
        sellerRefundCents = sellerRefundCents - affiliateRefundCents - affiliateRefundFeeCents;
      }
    }
    await run.reverseCredit(affiliateRefundCents, affiliateRefundFeeCents, null);
  }

  await processRefundForPurchaseBalanceBang(
    purchase,
    refund,
    { flowOfFunds: facts.flowOfFunds, refundCents: sellerRefundCents },
    options,
  );
}
