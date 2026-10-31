// Port of app/models/link.rb: the declarations the model-service runtime can express today.
// models/README.md lists what is still Ruby-only.
import type { Link } from "@prisma/client";

import { defineFlags } from "../../lib/flags";

import { deletable } from "./concerns/deletable";
import { hasPaperTrail } from "./concerns/paper-trail";
import { defineModel } from "./runtime/define-model";
import {
  isBlank,
  validatesFormatOf,
  validatesInclusionOf,
  validatesLengthOf,
  validatesPresenceOf,
  validatesUniquenessOf,
} from "./runtime/validators";

export const CUSTOM_PERMALINK_MAX_LENGTH = 255;
export const MAX_NAME_LENGTH = 255;
export const DEFAULT_BOOSTED_DISCOVER_FEE_PER_THOUSAND = 300;

export const NATIVE_TYPES_TO_TAX_CODE = {
  digital: "31000",
  course: "86132000A0002",
  ebook: "31000",
  newsletter: "55111516A0310",
  membership: "55111516A0310",
  podcast: "55111516A0310",
  audiobook: "31000",
  physical: null,
  bundle: "55111500A9220",
  commission: null,
  call: null,
  coffee: null,
} as const;
export const NATIVE_TYPES = Object.keys(NATIVE_TYPES_TO_TAX_CODE) as (keyof typeof NATIVE_TYPES_TO_TAX_CODE)[];

const DISCOVER_FEES_PER_THOUSAND = [100, ...Array.from({ length: 701 }, (_, i) => 300 + i)];

// Bit positions are persisted data: never renumber or reuse without resetting the column first.
export const LinkFlags = defineFlags(
  "links",
  {
    1: "product_refund_policy_enabled",
    2: "is_recurring_billing",
    3: "free_trial_enabled",
    4: "is_in_preorder_state",
    5: "archived",
    6: "is_duplicating",
    7: "is_licensed",
    8: "is_physical",
    9: "skus_enabled",
    10: "block_access_after_membership_cancellation",
    11: "is_price_tax_exclusive_DEPRECATED",
    12: "should_include_last_post",
    13: "from_bundle_marketing",
    14: "quantity_enabled",
    15: "has_outdated_purchases",
    16: "is_adult",
    17: "display_product_reviews",
    18: "allow_double_charges",
    19: "is_tiered_membership",
    20: "should_show_all_posts",
    21: "is_multiseat_license",
    22: "should_show_sales_count",
    23: "is_epublication",
    24: "transcode_videos_on_purchase",
    25: "has_same_rich_content_for_all_variants",
    26: "is_bundle",
    27: "purchasing_power_parity_disabled",
    28: "is_collab",
    29: "is_unpublished_by_admin",
    30: "community_chat_enabled",
    31: "created_via_cli",
    32: "DEPRECATED_moderated_by_iffy",
    33: "hide_sold_out_variants",
    34: "hide_bundle_product_reviews",
    35: "waitlist_enabled",
  },
  { queryMode: "bit_operator" },
);

const XML_TAGS = /<!--\?xml.+\?-->|<!--\[if gte mso.+<!\[endif\]-->/gsu;

const paperTrail = hasPaperTrail<Link>("Link", { itemType: "Link" });

export const Links = defineModel<Link>({
  rubyClass: "Link",
  prismaModel: "Link",
  delegate: (tx) => tx.link as never,
  validations: [
    validatesPresenceOf<Link>(["name"]),
    validatesLengthOf<Link>(["name"], { maximum: MAX_NAME_LENGTH }),
    validatesPresenceOf<Link>(["unique_permalink"]),
    validatesUniquenessOf<Link>("links", ["unique_permalink"], { case_sensitive: false }),
    validatesFormatOf<Link>(["unique_permalink"], { with: /^[a-zA-Z_]+$/u }),
    validatesFormatOf<Link>(["custom_permalink"], {
      with: /^[a-zA-Z0-9_-]+$/u,
      message: "can only contain letters, numbers, dashes, and underscores",
      allow_nil: true,
      allow_blank: true,
    }),
    validatesLengthOf<Link>(["custom_permalink"], {
      maximum: CUSTOM_PERMALINK_MAX_LENGTH,
      message: `must be ${CUSTOM_PERMALINK_MAX_LENGTH} characters or fewer`,
      allow_nil: true,
      allow_blank: true,
    }),
    validatesUniquenessOf<Link>("links", ["custom_permalink"], {
      scope: ["user_id"],
      case_sensitive: false,
      message: "is already used by another one of your products",
      allow_nil: true,
      allow_blank: true,
    }),
    validatesInclusionOf<Link>(["native_type"], { in: NATIVE_TYPES }),
    validatesInclusionOf<Link>(["discover_fee_per_thousand"], { in: DISCOVER_FEES_PER_THOUSAND, message: "must be between 30% and 100%" }),
    validatesPresenceOf<Link>(["filetype"]),
    validatesPresenceOf<Link>(["filegroup"]),
  ],
  beforeSave: [
    {
      name: "downcase_filetype",
      run: (record) => {
        const filetype = record.get("filetype");
        if (!isBlank(filetype)) record.set("filetype", filetype!.toLowerCase());
      },
    },
    {
      // Strips XML that Word and similar apps paste into descriptions.
      name: "remove_xml_tags",
      run: (record) => {
        const description = record.get("description");
        if (!isBlank(description)) record.set("description", description!.replace(XML_TAGS, ""));
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});

export const LinkDeletable = deletable(Links);
