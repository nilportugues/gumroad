// Create side of app/models/purchase_refund_policy.rb: the snapshot of the product's refund policy a purchase carries.
// Not ported: determine_max_refund_period_in_days (it can call an LLM) and the product-policy comparison, neither of
// which a create runs.
import type { PurchaseRefundPolicy } from "@prisma/client";

import { belongsToRequired, type BelongsTo, validatesUniqueness } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { strippedField } from "./user.ts";

export const PURCHASE_REFUND_POLICIES = "purchase_refund_policies";
// PurchaseRefundPolicy::MAX_REFUND_PERIOD_IN_DAYS_INTRODUCED_ON (Time.zone.parse, UTC)
export const MAX_REFUND_PERIOD_IN_DAYS_INTRODUCED_ON = new Date("2025-04-10T00:00:00Z");

const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const PurchaseRefundPolicies = defineModel<PurchaseRefundPolicy>({
  rubyClass: "PurchaseRefundPolicy",
  prismaModel: "PurchaseRefundPolicy",
  delegate: (tx) => tx.purchaseRefundPolicy as never,
  beforeValidation: [
    {
      name: "stripped_fields :title, :fine_print",
      run(record) {
        for (const field of ["title", "fine_print"] as const)
          record.set(field, strippedField(record.get(field)) as never);
      },
    },
  ],
  validations: [
    belongsToRequired<PurchaseRefundPolicy>(PURCHASE),
    // validates :purchase, uniqueness: true (on the association's foreign key)
    validatesUniqueness<PurchaseRefundPolicy>("PurchaseRefundPolicy", PURCHASE_REFUND_POLICIES, "purchase_id"),
    validatesPresenceOf<PurchaseRefundPolicy>(["title"]),
    {
      name: "validates :max_refund_period_in_days, presence: true, if: created after the cutoff",
      run(record, ctx) {
        const createdAt = (record.get("created_at") as Date | null | undefined) ?? ctx.now?.() ?? new Date();
        if (createdAt > MAX_REFUND_PERIOD_IN_DAYS_INTRODUCED_ON && record.get("max_refund_period_in_days") == null)
          record.errors.add("max_refund_period_in_days", "blank");
      },
    },
  ],
});
