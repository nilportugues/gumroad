// Port of app/models/user.rb: the declarations the model-service runtime can express today.
// models/README.md lists what is still Ruby-only.
import type { User } from "@prisma/client";

import { defineFlags } from "../../lib/flags";

import { deletable } from "./concerns/deletable";
import { hasPaperTrail } from "./concerns/paper-trail";
import { defineModel, type Callback } from "./runtime/define-model";
import { isBlank, validatesLengthOf, validatesNumericalityOf } from "./runtime/validators";

export const MAX_LENGTH_NAME = 100;
export const MAX_LENGTH_FACEBOOK_META_TAG = 100;

// Bit positions are persisted data: never renumber or reuse without resetting the column first.
export const UserFlags = defineFlags(
  "users",
  {
    1: "announcement_notification_enabled",
    2: "skip_free_sale_analytics",
    3: "purchasing_power_parity_enabled",
    4: "opt_out_simplified_pricing",
    5: "display_offer_code_field",
    6: "disable_reviews_after_year",
    7: "refund_fee_notice_shown",
    8: "refunds_disabled",
    9: "two_factor_authentication_enabled",
    10: "buyer_signup",
    11: "enforce_session_timestamping",
    12: "disable_third_party_analytics",
    13: "enable_verify_domain_third_party_services",
    14: "purchasing_power_parity_payment_verification_disabled",
    15: "bears_affiliate_fee",
    16: "enable_payment_email",
    17: "has_seen_discover",
    18: "should_paypal_payout_be_split",
    19: "pre_signup_affiliate_request_processed",
    20: "payouts_paused_internally",
    21: "disable_comments_email",
    22: "has_dismissed_upgrade_banner",
    23: "opted_into_upgrading_during_signup",
    24: "disable_reviews_email",
    25: "check_merchant_account_is_linked",
    26: "collect_eu_vat",
    27: "is_eu_vat_exclusive",
    28: "is_team_member",
    29: "has_dismissed_getting_started_checklist",
    30: "has_used_cli",
    31: "disable_paypal_sales",
    32: "all_adult_products",
    33: "enable_free_downloads_email",
    34: "enable_recurring_subscription_charge_email",
    35: "enable_payment_push_notification",
    36: "enable_recurring_subscription_charge_push_notification",
    37: "enable_free_downloads_push_notification",
    38: "million_dollar_announcement_sent",
    39: "disable_global_affiliate",
    40: "require_collab_request_approval",
    41: "payouts_paused_by_user",
    42: "opted_out_of_review_reminders",
    43: "tipping_enabled",
    44: "show_nsfw_products",
    45: "discover_boost_enabled",
    // Never read directly; User#account_level_refund_policy_enabled? owns its meaning.
    46: "refund_policy_enabled",
    47: "can_connect_stripe",
    48: "upcoming_refund_policy_change_email_sent",
    49: "DEPRECATED_can_create_physical_products",
    50: "paypal_payout_fee_waived",
    51: "dismissed_create_products_with_ai_promo_alert",
    52: "disable_affiliate_requests",
    53: "refund_policy_enforced",
    54: "disable_review_reminders",
    55: "ach_payments_enabled",
    56: "gifting_disabled",
    57: "content_moderation_disabled",
    58: "product_page_storefront_enabled",
    59: "DEPRECATED_has_dismissed_gumhead_promo",
    60: "hide_follow_form",
    61: "DEPRECATED_gumhead_enabled",
    62: "link_disabled",
    63: "paypal_card_funding_disabled",
  },
  { queryMode: "bit_operator" },
);

type UserFlag = (typeof UserFlags.names)[number];

const FLAGS_TO_ENABLE_BY_DEFAULT: UserFlag[] = [
  "enable_payment_email",
  "enable_payment_push_notification",
  "enable_free_downloads_email",
  "enable_free_downloads_push_notification",
];

const enableFlags = (name: string, flags: UserFlag[], unless?: Callback<User>["unless"]): Callback<User> => ({
  name,
  unless,
  run: (record) => {
    let value = record.get("flags");
    for (const flag of flags) value = UserFlags.set(value, flag, true);
    record.set("flags", value);
  },
});

const paperTrail = hasPaperTrail<User>("User", {
  itemType: "User",
  skip: ["encrypted_password", "reset_password_token", "confirmation_token", "otp_secret_key", "twitter_oauth_token", "twitter_oauth_secret", "facebook_access_token"],
});

export const Users = defineModel<User>({
  rubyClass: "User",
  prismaModel: "User",
  delegate: (tx) => tx.user as never,
  validations: [
    validatesLengthOf<User>(["name"], { maximum: MAX_LENGTH_NAME, too_long: "Your name is too long. Please try again with a shorter one." }),
    validatesLengthOf<User>(["facebook_meta_tag"], { maximum: MAX_LENGTH_FACEBOOK_META_TAG }),
    validatesNumericalityOf<User>(["purchasing_power_parity_limit"], { allow_nil: true, greater_than_or_equal_to: 1, less_than_or_equal_to: 100 }),
  ],
  beforeSave: [
    {
      name: "append_http",
      run: (record) => {
        const endpoint = record.get("notification_endpoint");
        if (!isBlank(endpoint) && !endpoint!.includes("http")) record.set("notification_endpoint", `http://${endpoint}`);
      },
    },
  ],
  beforeCreate: [
    enableFlags("init_default_notification_settings", FLAGS_TO_ENABLE_BY_DEFAULT),
    enableFlags("enable_two_factor_authentication", ["two_factor_authentication_enabled"], (r) => Boolean(r.ivars.skip_enabling_two_factor_authentication)),
    enableFlags("enable_tipping", ["tipping_enabled"]),
    enableFlags("enable_discover_boost", ["discover_boost_enabled"]),
    // New accounts only: existing creators keep the standalone product page until lift is measured.
    enableFlags("enable_product_page_storefront", ["product_page_storefront_enabled"]),
    enableFlags("set_refund_fee_notice_shown", ["refund_fee_notice_shown"]),
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});

export const UserDeletable = deletable(Users);
