// app/models/refund_policy.rb and seller_refund_policy.rb for the account-level policy the v2 API updates.
import { Prisma, type RefundPolicy } from "@prisma/client";

import { stripTags } from "../html/sanitizer.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, type BelongsTo, validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesLengthOf } from "./runtime/validators.ts";
import { column, table } from "./sql.ts";
import { strippedField, UserFlags } from "./user.ts";

// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS
export const ALLOWED_REFUND_PERIODS_IN_DAYS = [0, 7, 14, 30, 183] as const;
export const MAX_FINE_PRINT_LENGTH = 3_000;
// SellerRefundPolicy#refund_period_meets_enforcement_minimum
const ENFORCED_MINIMUM_REFUND_PERIOD_IN_DAYS = 7;

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
// STI subclasses version under their base class.
const paperTrail = hasPaperTrail<RefundPolicy>("RefundPolicy", { itemType: "RefundPolicy" });

const refundsGuaranteed = (days: number | null) => days !== null && days > 0;

export const RefundPolicies = defineModel<RefundPolicy>({
  rubyClass: "SellerRefundPolicy",
  prismaModel: "RefundPolicy",
  delegate: (tx) => tx.refundPolicy as never,
  beforeValidation: [
    {
      // stripped_fields :title, :fine_print, transform: strip_tags
      name: "stripped_fields :title, :fine_print",
      run(record) {
        for (const field of ["title", "fine_print"] as const) {
          const stripped = strippedField(record.get(field));
          record.set(field, stripped === null ? null : strippedField(stripTags(stripped)));
        }
      },
    },
  ],
  validations: [
    belongsToRequired<RefundPolicy>(SELLER),
    validatesAssociationPresence<RefundPolicy>(SELLER),
    validatesLengthOf<RefundPolicy>(["fine_print"], { maximum: MAX_FINE_PRINT_LENGTH }),
    validatesInclusionOf<RefundPolicy>(["max_refund_period_in_days"], { in: ALLOWED_REFUND_PERIODS_IN_DAYS }),
    {
      // The classifier calls an LLM; a save that needs it goes to Rails before anything is written.
      name: "fine_print_cannot_claim_no_refunds",
      run(record) {
        const needsClassifier =
          record.get("fine_print") !== null &&
          (record.attributeChanged("fine_print") || record.attributeChanged("max_refund_period_in_days")) &&
          refundsGuaranteed(record.get("max_refund_period_in_days"));
        if (needsClassifier) throw new NotPortedError("the fine print classifier");
      },
    },
    validatesAssociationPresence<RefundPolicy>(SELLER),
    {
      name: "validates :seller, uniqueness: { conditions: -> { where(product_id: nil) } }",
      async run(record, { tx }) {
        const where = Prisma.sql`${column("refund_policies", "seller_id")} = ${record.get("seller_id")}${record.persisted ? Prisma.sql` AND ${column("refund_policies", "id")} != ${record.get("id")}` : Prisma.empty} AND ${column("refund_policies", "product_id")} IS NULL`;
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table("refund_policies")} WHERE ${where} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("seller", "taken");
      },
    },
    {
      name: "refund_period_meets_enforcement_minimum",
      async run(record, { tx }) {
        const sellerId = record.get("seller_id");
        // A fresh read: the flag can have been set earlier in the same request.
        const rows = await tx.$queryRaw<{ flags: bigint }[]>(
          Prisma.sql`SELECT ${column("users", "flags")} AS flags FROM ${table("users")} WHERE ${column("users", "id")} = ${sellerId}`,
        );
        const enforced = rows.some((row) => UserFlags.isSet(BigInt(row.flags), "refund_policy_enforced"));
        const days = record.get("max_refund_period_in_days");
        if (enforced && !(days !== null && days >= ENFORCED_MINIMUM_REFUND_PERIOD_IN_DAYS)) {
          record.errors.add(
            "max_refund_period_in_days",
            "must offer a refund period of at least 7 days while a refund policy is enforced on this account",
          );
        }
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});
