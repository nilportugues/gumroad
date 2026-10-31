// The has_flags mappings the indexed documents read (`selected_flags` lists them in this order).
import { defineFlags } from "../../lib/flags.ts";

export const PURCHASE_FLAG_MAPPING = {
  1: "is_additional_contribution",
  2: "is_refund_chargeback_fee_waived",
  3: "is_original_subscription_purchase",
  4: "is_preorder_authorization",
  5: "is_multi_buy",
  6: "is_gift_receiver_purchase",
  7: "is_gift_sender_purchase",
  8: "DEPRECATED_credit_card_zipcode_required",
  9: "was_product_recommended",
  10: "chargeback_reversed",
  11: "was_zipcode_check_performed",
  12: "is_upgrade_purchase",
  13: "was_purchase_taxable",
  14: "was_tax_excluded_from_price",
  15: "is_rental",
  16: "was_discover_fee_charged",
  17: "is_archived",
  18: "is_archived_original_subscription_purchase",
  19: "is_free_trial_purchase",
  20: "is_deleted_by_buyer",
  21: "is_buyer_blocked_by_admin",
  22: "is_multiseat_license",
  23: "should_exclude_product_review",
  24: "is_purchasing_power_parity_discounted",
  25: "is_access_revoked",
  26: "is_bundle_purchase",
  27: "is_bundle_product_purchase",
  28: "is_part_of_combined_charge",
  29: "is_commission_deposit_purchase",
  30: "is_commission_completion_purchase",
  31: "is_installment_payment",
  32: "is_reassignment_locked",
  33: "is_indian_card_mandate_registration",
  34: "indian_card_mandate_missing",
  35: "indian_card_mandate_inactive",
  36: "indian_card_mandate_pending",
} as const;

export const PurchaseFlags = defineFlags("purchases", PURCHASE_FLAG_MAPPING, { queryMode: "bit_operator" });

export const INSTALLMENT_FLAG_MAPPING = {
  1: "is_unpublished_by_admin",
  2: "DEPRECATED_is_automated_installment",
  3: "DEPRECATED_stream_only",
  4: "DEPRECATED_is_open_rate_tracking_enabled",
  5: "DEPRECATED_is_click_rate_tracking_enabled",
  6: "is_for_new_customers_of_workflow",
  7: "workflow_installment_published_once_already",
  8: "shown_on_profile",
  9: "send_emails",
  10: "ready_to_publish",
  11: "allow_comments",
  12: "single_recipient_email",
} as const;

export const InstallmentFlags = defineFlags("installments", INSTALLMENT_FLAG_MAPPING, { queryMode: "bit_operator" });

// flag_shih_tzu `selected_flags`: the set flags, in mapping order.
export function selectedFlags(mapping: Record<number, string>, flags: bigint | number | null | undefined): string[] {
  const value = BigInt(flags ?? 0);
  return Object.entries(mapping)
    .filter(([position]) => (value & (1n << BigInt(Number(position) - 1))) !== 0n)
    .map(([, name]) => name);
}
