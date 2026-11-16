# frozen_string_literal: true

# Writes the constant data the Payouts page reads (PayoutsHelper, User::PayoutSchedule, BankAccount#to_hash), for
# src/server/page-props/payouts/payouts-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-payouts-data.rb
#
# Re-run it when a bank account class, config/sidekiq_schedule.yml's payout jobs, PayoutNoteVisibility's list or
# the payout constants change.
require "json"

Rails.application.eager_load!

bank_accounts = BankAccount.descendants.reject { _1 == CardBankAccount }.sort_by(&:name)

data = {
  "bankAccountType" => bank_accounts.to_h { [_1.name, _1.new.bank_account_type] },
  "bankAccountCurrency" => bank_accounts.to_h { [_1.name, _1.new.currency] },
  "railWeekday" => {
    "bankAccountTypes" => bank_accounts.to_h { [_1.name, PayoutRailSchedule.weekday_for_bank_account_type(_1.name).to_s] },
    "paypal" => PayoutRailSchedule.paypal_weekday.to_s,
    "stripeConnect" => PayoutRailSchedule.stripe_connect_weekday.to_s,
  },
  "legacyInternalNotePrefixes" => PayoutNoteVisibility.legacy_internal_note_prefixes,
  "constants" => {
    "payoutDelayDays" => User::PayoutSchedule::PAYOUT_DELAY_DAYS,
    "rejectedAccountMinAmountCents" => Payouts::REJECTED_ACCOUNT_MIN_AMOUNT_CENTS,
    "chargebackRatePayoutReservePercent" => User::CHARGEBACK_RATE_PAYOUT_RESERVE_PERCENT,
    "highChargebackRateAuthor" => User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:high_chargeback_rate],
    "systemPayoutPausingAuthors" => User::SYSTEM_PAYOUT_PAUSING_COMMENT_AUTHORS,
    "maxPayoutNotesScanned" => PayoutNoteVisibility::MAX_NOTES_SCANNED,
    "pastPaymentsPerPage" => PayoutsPresenter::PAST_PAYMENTS_PER_PAGE,
    "oldestDisplayablePayoutDate" => PayoutsHelper::OLDEST_DISPLAYABLE_PAYOUT_PERIOD_END_DATE.to_s,
    "belowMinimumNoteRegex" => PayoutsHelper::BELOW_MINIMUM_PAYOUT_NOTE_REGEX.source,
    "underReviewNoteRegex" => PayoutsHelper::UNDER_REVIEW_PAYOUT_NOTE_REGEX.source,
  },
}

File.write(Rails.root.join("nextjs/src/server/page-props/payouts/payouts-data.generated.json"), "#{JSON.generate(data)}\n")
