// Purchase#refund_purchase! (app/modules/purchase/refundable.rb) from the transaction's `reload.lock!` down to the VAT-exclusive credit, in
// Ruby's order: the flags, `build_refund`, the Refund row (`refunds << refund`), the fee waiver, the balance decrement, the purchase's
// `save!`, the retained-fee debit and the VAT credit. Golden: __fixtures__/refund-purchase-body.golden.json
// (scripts/golden/refund-purchase-body.rb), run by the real method and stopped where it would notify the seller's webhook.
//
// Not served by any route, and not complete: what Ruby does after the VAT credit (the webhook, the buyer's mail, the analytics cache, the
// Elasticsearch index, LowBalanceFraudCheckWorker, the license) is the caller's `tail`, so a refund cannot finish without it. The
// processor's refund is an input, never made here. Refused before the first statement: a buyer-currency presentment, a gift, a
// subscription, a bundle, any chargeback, PayPal and Braintree. Refused after the lock and before the first write: a partial refund
// of a sale that charged a Gumroad VAT, and a refund of one whose VAT was already refunded.
// Refused inside the transaction after writes, which the caller's rollback discards: a retained fee that is collected from Stripe
// after commit (an account Gumroad manages for the seller).
import { Prisma } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";

import type { SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import {
  chargedUsingGumroadMerchantAccount,
  isStripeConnect,
  type ChargeMerchantAccount,
} from "./purchase-charge-facts.ts";
import { Purchases, type PurchaseRecord } from "./purchase-create.ts";
import { loadLinkAssociations, markAssociationsReloaded } from "./purchase-reloaded-associations.ts";
import { decrementBalanceForRefundBang } from "./refund-affiliate-balance.ts";
import { createForRefundFeeRetentionBang } from "./refund-fee-retention-credit.ts";
import { buildRefund, type RefundSale } from "./refund-ledger.ts";
import { hasPresentment } from "./refund-seller-balance.ts";
import { createForVatExclusiveRefundBang } from "./refund-vat-exclusive-credit.ts";
import { appendRefund, assignRefundAttribute, refundJsonAttr, Refunds, type RefundRecord } from "./refund.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, connection, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const MERCHANT_ACCOUNT: BelongsTo = {
  name: "merchant_account",
  foreignKey: "merchant_account_id",
  targetTable: "merchant_accounts",
  targetModel: "MerchantAccount",
};

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#refund_purchase! with ${what}`, "app/modules/purchase/refundable.rb:288");

// Refund.effective
const EFFECTIVE = Prisma.sql`(refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')`;

// `refunds.effective.sum(:<name>)`
async function effectiveSum(purchaseId: unknown, name: string): Promise<number> {
  const [row] = await selectRows(
    Prisma.sql`SELECT SUM(${column("refunds", name)}) FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchaseId} AND ${EFFECTIVE}`,
  );
  return Number(Object.values(row ?? {})[0] ?? 0);
}

// Purchase::Refundable#refundable_amounts' one query
async function effectiveSumsOfAll(purchaseId: unknown) {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COALESCE(SUM(total_transaction_cents), 0) AS tt_cents, COALESCE(SUM(amount_cents), 0) AS p_cents, COALESCE(SUM(creator_tax_cents), 0) AS ct_cents, COALESCE(SUM(gumroad_tax_cents), 0) as gt_cents,COALESCE(SUM(fee_cents), 0) AS ft_cents FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchaseId} AND ${EFFECTIVE} ORDER BY ${column("refunds", "id")} ASC LIMIT 1`,
  );
  return {
    total_transaction_cents: Number(row!.tt_cents),
    amount_cents: Number(row!.p_cents),
    creator_tax_cents: Number(row!.ct_cents),
    gumroad_tax_cents: Number(row!.gt_cents),
    fee_cents: Number(row!.ft_cents),
  };
}

export type RefundBodyArguments = {
  flowOfFunds: SellerFlowOfFunds;
  refundingUserId: number;
  // what the processor answered: `stripe_refund.status` and `.id`
  stripeRefund?: { status: string; id: string } | null;
  isForFraud?: boolean;
  note?: string | null;
  gumroadFunded?: boolean;
  balanceReconciliationNeeded?: boolean;
};

const flag = (purchase: PurchaseRecord, name: (typeof PurchaseFlags.names)[number]) =>
  PurchaseFlags.isSet(purchase.get("flags"), name);

function refuseBeforeAnyStatement(purchase: PurchaseRecord): void {
  if (flag(purchase, "is_gift_sender_purchase")) throw notPorted("a gift");
  if (purchase.get("subscription_id") != null) throw notPorted("a subscription");
  if (flag(purchase, "is_bundle_purchase")) throw notPorted("a bundle");
  if (purchase.get("chargeback_date") != null || purchase.get("purchase_chargeback_balance_id") != null)
    throw notPorted("a chargeback");
  if (purchase.get("paypal_order_id") != null) throw notPorted("a PayPal order");
  if (purchase.get("charge_processor_id") !== "stripe") throw notPorted("a processor other than Stripe");
}

// The Refund as `build_refund` makes it, from the sums only the branch it takes reads (each is a query in Ruby).
async function buildRefundRecord(
  purchase: PurchaseRecord,
  sale: RefundSale,
  flags: { stripe_refunded: boolean; stripe_partially_refunded: boolean },
  fundsRefundedCents: number,
  refundingUserId: number,
): Promise<RefundRecord | null> {
  const id = purchase.get("id");
  const empty = {
    total_transaction_cents: 0,
    amount_cents: 0,
    fee_cents: 0,
    creator_tax_cents: 0,
    gumroad_tax_cents: 0,
  };
  let sums = empty;
  if (sale.stripe_partially_refunded === true && flags.stripe_refunded) {
    sums = await effectiveSumsOfAll(id);
  } else if (fundsRefundedCents === sale.total_transaction_cents) {
    sums = { ...empty, gumroad_tax_cents: await effectiveSum(id, "gumroad_tax_cents") };
  } else if (fundsRefundedCents > 0) {
    // partial_refund_amount_acceptable?: gross_amount_refundable_cents
    if (sale.gumroad_tax_cents > 0) throw notPorted("a partial refund of a sale that charged a Gumroad VAT");
    sums = {
      ...empty,
      amount_cents: await effectiveSum(id, "amount_cents"),
      gumroad_tax_cents: await effectiveSum(id, "gumroad_tax_cents"),
    };
  }
  const draft = buildRefund({ sale, sums, flags, grossRefundAmount: fundsRefundedCents, refundingUserId });
  if (draft === null) return null;
  const refund = Refunds.build({});
  for (const [key, value] of Object.entries(draft)) assignRefundAttribute(refund, key, value);
  return refund;
}

// `ActiveRecord::Base.transaction do ... end` of refund_purchase!, up to `send_refunded_notification_webhook`, where `tail` takes over.
// Answers false (and commits) where Ruby does: the refund could not be built. `purchase` is reloaded and locked.
export async function refundPurchaseBodyBang(
  purchase: PurchaseRecord,
  args: RefundBodyArguments,
  tail: (refund: RefundRecord) => Promise<boolean>,
  options: SaveOptions = {},
): Promise<boolean> {
  refuseBeforeAnyStatement(purchase);
  // buyer_presentment?
  if (await hasPresentment(purchase)) throw notPorted("a buyer-currency presentment");
  const fundsRefundedCents = Math.abs(args.flowOfFunds.issuedAmount.cents);

  return transaction(async () => {
    // reload first: lock! raises on a record with unsaved changes
    await Purchases.reload(purchase);
    await Purchases.lockBang(purchase);
    markAssociationsReloaded(purchase);
    const partiallyRefundedPreviously = purchase.get("stripe_partially_refunded");
    const grossRefundedCents =
      (await effectiveSum(purchase.get("id"), "amount_cents")) +
      (await effectiveSum(purchase.get("id"), "gumroad_tax_cents"));
    const stripeRefunded = grossRefundedCents + fundsRefundedCents >= purchase.get("total_transaction_cents")!;
    purchase.set("stripe_refunded", stripeRefunded);
    purchase.set("stripe_partially_refunded", !stripeRefunded);
    const flags = { stripe_refunded: stripeRefunded, stripe_partially_refunded: !stripeRefunded };

    const vatAlreadyRefunded =
      purchase.get("gumroad_tax_cents")! > 0 &&
      purchase.get("gumroad_tax_cents") === (await effectiveSum(purchase.get("id"), "gumroad_tax_cents"));
    if (vatAlreadyRefunded) throw notPorted("a sale whose VAT was already refunded");

    const sale: RefundSale = {
      price_cents: purchase.get("price_cents")!,
      total_transaction_cents: purchase.get("total_transaction_cents")!,
      fee_cents: purchase.get("fee_cents")!,
      tax_cents: purchase.get("tax_cents") ?? 0,
      gumroad_tax_cents: purchase.get("gumroad_tax_cents") ?? 0,
      affiliate_credit_cents: purchase.get("affiliate_credit_cents") ?? 0,
      // stripe_partially_refunded_was: the value after the reload, before the flags above
      stripe_partially_refunded: partiallyRefundedPreviously,
    };
    const refund = await buildRefundRecord(purchase, sale, flags, fundsRefundedCents, args.refundingUserId);
    // Ruby's `unless refund.present?` returns from inside the block, which commits
    if (refund === null) return false;

    if (args.stripeRefund) {
      assignRefundAttribute(refund, "status", args.stripeRefund.status);
      assignRefundAttribute(refund, "processor_refund_id", args.stripeRefund.id);
    }
    assignRefundAttribute(refund, "is_for_fraud", args.isForFraud === true);
    if (args.gumroadFunded) assignRefundAttribute(refund, "gumroad_funded", true);
    if (args.balanceReconciliationNeeded) assignRefundAttribute(refund, "balance_reconciliation_needed", true);
    const skipSellerBalance = args.gumroadFunded === true || args.balanceReconciliationNeeded === true;
    if (args.note) assignRefundAttribute(refund, "note", args.note);
    await appendRefund(purchase, refund, options);

    const account = (await loadBelongsTo(purchase, MERCHANT_ACCOUNT, {
      tx: (await connection()) as never,
    })) as ChargeMerchantAccount | null;
    const chargedOnGumroad = chargedUsingGumroadMerchantAccount(account, purchase.get("charge_processor_id"));
    const feeWaived = !chargedOnGumroad || args.isForFraud === true;
    purchase.set(
      "flags",
      PurchaseFlags.set(purchase.get("flags"), "is_refund_chargeback_fee_waived", feeWaived) as never,
    );

    if (!skipSellerBalance)
      await decrementBalanceForRefundBang(purchase, refund, { flowOfFunds: args.flowOfFunds }, options);
    await loadLinkAssociations(purchase);
    await Purchases.saveBang(purchase, options);

    if (!feeWaived && !skipSellerBalance) {
      await createForRefundFeeRetentionBang(purchase, refund, options);
      // the collection from Stripe runs after commit and is not ported
      if (refundJsonAttr(refund, "fee_retention_pending") === true)
        throw notPorted("a retained fee collected from Stripe");
    }
    if (account !== null && isStripeConnect(account) && !skipSellerBalance)
      await createForVatExclusiveRefundBang(purchase, refund, options);

    return tail(refund);
  });
}
