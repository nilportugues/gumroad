// StripePayoutProcessor.stripe_invalid_request_error_failure_reason and the constants it maps to. Golden: payouts-prepare.golden.json
// (`failure_reasons`, recorded from the Ruby method).
import type { InvalidRequestError } from "../stripe/errors.ts";

export const FailureReason = {
  CANNOT_PAY: "cannot_pay",
  DEBIT_CARD_LIMIT: "debit_card_limit",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  BANK_ACCOUNT_NOT_FOUND_AT_STRIPE: "bank_account_not_found_at_stripe",
  CURRENCY_MISMATCH: "currency_mismatch",
  DESTINATION_CURRENCY_MISMATCH: "destination_currency_mismatch",
  BELOW_STRIPE_PAYOUT_MINIMUM: "below_stripe_payout_minimum",
  STRIPE_INTERVENTION_REQUIRED: "stripe_intervention_required",
  PROCESSOR_RATE_LIMITED: "processor_rate_limited",
  PROCESSOR_UNAVAILABLE: "processor_unavailable",
  PAYOUT_OUTCOME_UNKNOWN: "payout_outcome_unknown",
  DESTINATION_LEDGER_NEGATIVE: "destination_ledger_negative",
  DESTINATION_ACCOUNT_RETIRED: "destination_account_retired",
} as const;

// BankAccount::STALE_EXTERNAL_ACCOUNT_MESSAGES
export const STALE_EXTERNAL_ACCOUNT_MESSAGES = [
  /has been deleted and can no longer be used/u,
  /No such external account/u,
];

export function stripeInvalidRequestErrorFailureReason(error: InvalidRequestError): string | null {
  if (error.code === "balance_insufficient") return FailureReason.INSUFFICIENT_FUNDS;
  const message = error.message;
  if (message.includes("Cannot create live transfers") || message.includes("Cannot create payouts"))
    return FailureReason.CANNOT_PAY;
  // MISSING_CAPABILITY_MESSAGE: outstanding requirements disabled the account's transfers capability.
  if (message.includes("needs to have at least one of the following capabilities enabled"))
    return FailureReason.CANNOT_PAY;
  if (message.includes("Debit card transfers are only supported for amounts less"))
    return FailureReason.DEBIT_CARD_LIMIT;
  if (/insufficient funds in (your )?Stripe account/iu.test(message)) return FailureReason.INSUFFICIENT_FUNDS;
  if (STALE_EXTERNAL_ACCOUNT_MESSAGES.some((pattern) => pattern.test(message)))
    return FailureReason.BANK_ACCOUNT_NOT_FOUND_AT_STRIPE;
  // Stripe appends an alternative-account suggestion, so the sentence is not matched to its end.
  if (/^Attempting to create a transfer of [a-z]{3} to a destination that supports [a-z]{3}/u.test(message))
    return FailureReason.DESTINATION_CURRENCY_MISMATCH;
  if (message.startsWith("Amount must be no less than")) return FailureReason.BELOW_STRIPE_PAYOUT_MINIMUM;
  if (message.includes("requires further intervention")) return FailureReason.STRIPE_INTERVENTION_REQUIRED;
  return null;
}
