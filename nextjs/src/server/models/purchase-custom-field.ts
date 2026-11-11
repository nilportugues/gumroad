// app/models/purchase_custom_field.rb for PurchaseCustomFieldsController#create: a buyer's answer to a post-purchase text or long text
// field. Boolean fields and attached files stay in Ruby, so those branches of `value_valid_for_custom_field` throw NotPortedError.
import { Prisma, type PurchaseCustomField } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";

import { belongsToRequired, loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { CUSTOM_FIELD_TYPES } from "./custom-field.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank, validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError, rubyStrip } from "./user.ts";

const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};
const CUSTOM_FIELD: BelongsTo = {
  name: "custom_field",
  foreignKey: "custom_field_id",
  targetTable: "custom_fields",
  targetModel: "CustomField",
};

export const PurchaseCustomFieldFlags = defineFlags(
  "purchase_custom_fields",
  { 1: "is_post_purchase" },
  { queryMode: "bit_operator" },
);

// `normalizes :value, with: -> { _1&.strip&.squeeze(" ").presence }`
export function normalizeValue(value: string | null): string | null {
  if (value === null) return null;
  const squeezed = rubyStrip(value).replace(/ {2,}/gu, " ");
  return isBlank(squeezed) ? null : squeezed;
}

export const PurchaseCustomFields = defineModel<PurchaseCustomField>({
  rubyClass: "PurchaseCustomField",
  prismaModel: "PurchaseCustomField",
  delegate: (tx) => tx.purchaseCustomField as never,
  validations: [
    belongsToRequired<PurchaseCustomField>(PURCHASE),
    validatesInclusionOf<PurchaseCustomField>(["field_type"], { in: CUSTOM_FIELD_TYPES }),
    validatesPresenceOf<PurchaseCustomField>(["name"]),
    {
      name: "value_valid_for_custom_field",
      async run(record, ctx) {
        const customField = await loadBelongsTo(record, CUSTOM_FIELD, ctx);
        if (customField === null) return;
        const type = customField.field_type;
        if (type !== "text" && type !== "long_text")
          throw new NotPortedError(
            "PurchaseCustomField#value_valid_for_custom_field",
            "a field that is not text or long text",
          );
        if (customField.required && isBlank(record.get("value") ?? "")) record.errors.add("value", "blank");
      },
    },
  ],
});

// `purchase.purchase_custom_fields.find_by(custom_field_id:)`
export async function findForCustomField(purchaseId: bigint | number, customFieldId: bigint | number) {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_custom_fields`.*")} FROM ${table("purchase_custom_fields")} WHERE ${column("purchase_custom_fields", "purchase_id")} = ${purchaseId} AND ${column("purchase_custom_fields", "custom_field_id")} = ${customFieldId} LIMIT 1`,
  );
  return row ? PurchaseCustomFields.load(castRow<PurchaseCustomField>("PurchaseCustomField", row)) : null;
}

// `PurchaseCustomField.build_from_custom_field(custom_field:, value:)` for a post-purchase field.
export function buildFromCustomField(
  purchaseId: bigint | number,
  customField: { id: bigint | number; name: string | null; field_type: string | null },
  value: string | null,
) {
  return PurchaseCustomFields.build({
    purchase_id: BigInt(purchaseId),
    custom_field_id: BigInt(customField.id),
    name: customField.name ?? "",
    field_type: customField.field_type ?? "",
    value: normalizeValue(value),
    flags: PurchaseCustomFieldFlags.set(0, "is_post_purchase", true),
  });
}
