// app/models/affiliate_partial_refund.rb: the part of an affiliate's credit a partial refund gave back. Written by
// Purchase#process_refund_or_chargeback_for_affiliate_credit_balance (refund-affiliate-balance.ts).
// Golden: __fixtures__/refund-affiliate-balance.golden.json (scripts/golden/refund-affiliate-balance.rb).
import type { AffiliatePartialRefund } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { attributesCommitted, transactionalAttributeChangeTracker } from "./concerns/transactional-attribute-change-tracker.ts";
import { loadBelongsTo, validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { connection } from "./sql.ts";

// Purchase::Searchable::AffiliatePartialRefundCallbacks: ElasticsearchIndexerWorker.perform_in(2.seconds, ...)
const PURCHASE_INDEX_DELAY_SECONDS = 2;

const association = (name: string, targetTable: string, targetModel: BelongsTo["targetModel"]): BelongsTo => ({
  name,
  foreignKey: `${name}_id`,
  targetTable,
  targetModel,
});
export const PARTIAL_REFUND_ASSOCIATIONS = {
  affiliate_user: association("affiliate_user", "users", "User"),
  affiliate_credit: association("affiliate_credit", "affiliate_credits", "AffiliateCredit"),
  seller: association("seller", "users", "User"),
  purchase: association("purchase", "purchases", "Purchase"),
  affiliate: association("affiliate", "affiliates", "Affiliate"),
  balance: association("balance", "balances", "Balance"),
} as const;

const tracker = transactionalAttributeChangeTracker<AffiliatePartialRefund>();

export const AffiliatePartialRefunds = defineModel<AffiliatePartialRefund>({
  rubyClass: "AffiliatePartialRefund",
  prismaModel: "AffiliatePartialRefund",
  delegate: (tx) => tx.affiliatePartialRefund as never,
  validations: Object.values(PARTIAL_REFUND_ASSOCIATIONS).map((belongsTo) =>
    validatesAssociationPresence<AffiliatePartialRefund>(belongsTo),
  ),
  afterSave: tracker.afterSave,
  beforeCommit: tracker.beforeCommit,
  afterCommit: [
    {
      name: "update_purchase_index",
      on: ["create", "update"],
      async run(partialRefund) {
        if (!attributesCommitted(partialRefund).includes("amount_cents")) return;
        const credit = await loadBelongsTo(partialRefund, PARTIAL_REFUND_ASSOCIATIONS.affiliate_credit, {
          tx: (await connection()) as never,
        });
        const fields = credit?.is_direct_affiliate_credit
          ? [
              "direct_affiliate_credit_amount_partially_refunded_cents",
              "direct_affiliate_credit_fee_partially_refunded_cents",
            ]
          : [
              "affiliate_credit_amount_partially_refunded_cents",
              "affiliate_credit_fee_partially_refunded_cents",
            ];
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["update", { record_id: partialRefund.get("purchase_id"), class_name: "Purchase", fields }] as never,
          { delaySeconds: PURCHASE_INDEX_DELAY_SECONDS },
        );
      },
    },
  ],
});
