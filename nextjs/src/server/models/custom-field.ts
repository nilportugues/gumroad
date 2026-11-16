// app/models/custom_field.rb for the checkout form's writes (Checkout::FormController#update): the validations in the order Rails
// declares them, the default name of a file field, and the flags.
import type { CustomField } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { HTTP_URI_REGEXP } from "../../lib/ruby-uri-regexp.ts";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank, validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";

export const CUSTOM_FIELD_TYPES = ["text", "checkbox", "terms", "long_text", "file"] as const;
export const FILE_FIELD_NAME = "File upload";
const BOOLEAN_TYPES = ["terms", "checkbox"];
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

export const CustomFieldFlags = defineFlags(
  "custom_fields",
  { 1: "is_post_purchase", 2: "collect_per_product" },
  { queryMode: "bit_operator" },
);

export type CustomFieldRecord = ModelRecord<CustomField>;

export const CustomFields = defineModel<CustomField>({
  rubyClass: "CustomField",
  prismaModel: "CustomField",
  delegate: (tx) => tx.customField as never,
  beforeValidation: [
    {
      name: "set_default_name",
      run(record) {
        if (record.get("field_type") === "file" && isBlank(record.get("name"))) record.set("name", FILE_FIELD_NAME);
      },
    },
  ],
  validations: [
    belongsToRequired<CustomField>(SELLER),
    validatesInclusionOf<CustomField>(["field_type"], { in: CUSTOM_FIELD_TYPES }),
    validatesPresenceOf<CustomField>(["name"]),
    {
      name: "terms_valid_uri",
      run(record) {
        if (record.get("field_type") === "terms" && !HTTP_URI_REGEXP.test(record.get("name") ?? "")) {
          record.errors.add("base", "Please provide a valid URL for custom field of Terms type.");
        }
      },
    },
    {
      name: "type_not_boolean_if_post_purchase",
      run(record) {
        if (
          CustomFieldFlags.isSet(record.get("flags"), "is_post_purchase") &&
          BOOLEAN_TYPES.includes(record.get("field_type") ?? "")
        ) {
          record.errors.add("base", "Boolean post-purchase fields are not allowed");
        }
      },
    },
  ],
});
