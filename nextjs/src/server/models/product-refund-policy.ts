// app/models/product_refund_policy.rb (and the RefundPolicy it inherits) for the policy POST /v2/products gives a product it has just
// created: `find_or_initialize_product_refund_policy.update!`. The fine print classifier calls an LLM, so a save that needs it is
// refused before anything is written (see `needsClassifier`); the validations that cannot fail for a fresh product of the seller
// (the product's uniqueness and ownership) are kept so the model reads as Rails does.
import { Prisma, type RefundPolicy } from "@prisma/client";

import { stripTags } from "../html/sanitizer.ts";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, type BelongsTo, validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { ALLOWED_REFUND_PERIODS_IN_DAYS, MAX_FINE_PRINT_LENGTH } from "./refund-policy.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesLengthOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { strippedField } from "./user.ts";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };
const paperTrail = hasPaperTrail<RefundPolicy>("RefundPolicy", { itemType: "RefundPolicy" });

// RefundPolicy#fine_print_cannot_claim_no_refunds runs for a present fine print beside a period that guarantees refunds.
export const needsClassifier = (finePrint: string | null, days: number): boolean =>
  finePrint !== null && finePrint.trim() !== "" && days > 0;

export const ProductRefundPolicies = defineModel<RefundPolicy>({
  rubyClass: "ProductRefundPolicy",
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
    belongsToRequired<RefundPolicy>(PRODUCT),
    validatesAssociationPresence<RefundPolicy>(PRODUCT),
    {
      // validates :product, uniqueness: true
      name: "validates :product, uniqueness",
      async run(record) {
        const rows = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("refund_policies")} WHERE ${column("refund_policies", "product_id")} = ${record.get("product_id")}${record.persisted ? Prisma.sql` AND ${column("refund_policies", "id")} != ${record.get("id")}` : Prisma.empty} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("product", "taken");
      },
    },
    {
      name: "product_must_belong_to_seller",
      async run(record) {
        const rows = await selectRows<{ user_id: bigint | null }>(
          Prisma.sql`SELECT ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${record.get("product_id")} LIMIT 1`,
        );
        if (rows[0] !== undefined && rows[0].user_id !== record.get("seller_id"))
          record.errors.add("product", "invalid");
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
});
