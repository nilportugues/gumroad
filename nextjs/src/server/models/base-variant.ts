// Port of the `has_flags` declaration of app/models/base_variant.rb, for the queries that filter on it.
import { defineFlags } from "../../lib/flags.ts";

export const BaseVariantFlags = defineFlags(
  "base_variants",
  {
    1: "is_default_sku",
    2: "apply_price_changes_to_existing_memberships",
    3: "closed_to_new_purchases",
  },
  { queryMode: "bit_operator" },
);
