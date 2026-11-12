# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payment-state-machine.golden.json: the Payment state
# machine (app/models/payment.rb) and Balance's, run by the real models against a scratch database,
# for a Stripe payout: mark_processing!, mark_failed! with its callbacks (the balances back to unpaid,
# the failure-reason comment, the cannot-pay and debit-card mails, the pause after repeated failures)
# and Credit.create_for_returned_payment_difference!. See support/rails_cases.rb for what each case
# records. Run from the repository root under the test environment, pointed at a scratch database and
# Redis db (it truncates the tables it uses and flushes the Redis db):
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payment-state-machine.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payment-state-machine.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions seller_profiles links].freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 1000, holding_amount_cents: 1000, state: "processing", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, **overrides)
  { id:, user_id: 5, state: "processing", processor: "STRIPE", amount_cents: 1000, payout_period_end_date: "2025-10-31", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: nil, created_at: "2025-10-31 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

def links(payment_id, *balance_ids)
  balance_ids.each_with_index.map { |balance_id, i| { id: payment_id * 10 + i, payment_id:, balance_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze

def base_seed(payments:, balances: [balance_row(1), balance_row(2, amount_cents: 500, holding_amount_cents: 500)], extra: {})
  {
    users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")],
    payments:, balances:, payments_balances: payments.flat_map { |p| links(p[:id], *balances.map { _1[:id] }.first(2)) },
    bank_accounts: [BANK], merchant_accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT]
  }.merge(extra)
end

def run(name, seed:, **extra, &block) = capture(name, now: NOW, tables: TABLES, seed:, **extra, &block)

cases = []

cases << run("mark_processing! moves a creating payment to processing", seed: base_seed(payments: [payment_row(7, state: "creating")])) do
  Payment.find(7).mark_processing!
end

cases << run("mark_processing! from processing is not a transition", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_processing!
end

cases << run("mark_failed! with a transient reason returns the balances to unpaid and comments nothing", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::PROCESSOR_RATE_LIMITED)
end

cases << run("mark_failed! with no reason", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!
end

cases << run("mark_failed! from creating skips the processing callbacks", seed: base_seed(payments: [payment_row(7, state: "creating")])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::BANK_ACCOUNT_NOT_FOUND_AT_STRIPE)
end

cases << run("mark_failed! with a reason that has a solution adds a seller-visible payout note", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::BANK_ACCOUNT_NOT_FOUND_AT_STRIPE)
end

cases << run("mark_failed! for an amount below the Stripe minimum", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::BELOW_STRIPE_PAYOUT_MINIMUM)
end

cases << run("mark_failed! for destination_currency_mismatch", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::DESTINATION_CURRENCY_MISMATCH)
end

cases << run("mark_failed! for stripe_intervention_required", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::STRIPE_INTERVENTION_REQUIRED)
end

cases << run("mark_failed! cannot_pay mails the seller once and records the period", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::CANNOT_PAY)
end

cases << run("mark_failed! cannot_pay does not mail twice for the same period", seed: base_seed(
  payments: [payment_row(7)],
  extra: { users: [user_row(5, json_data: '{"payout_date_of_last_payment_failure_email":"2025-10-31"}'), user_row(767_082, email: "admin@example.com", username: "admin")] }
)) do
  Payment.find(7).mark_failed!(Payment::FailureReason::CANNOT_PAY)
end

cases << run("mark_failed! debit_card_limit mails the seller", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::DEBIT_CARD_LIMIT)
end

cases << run("mark_failed! with an unaccounted-money reason", seed: base_seed(payments: [payment_row(7)])) do
  Payment.find(7).mark_failed!(Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
end

# Two earlier failures to the same bank account: this one is the third and pauses the seller.
earlier_failures = [
  payment_row(8, state: "failed", failure_reason: "account_closed", created_at: "2025-10-01 10:00:00"),
  payment_row(9, state: "returned", failure_reason: nil, created_at: "2025-10-08 10:00:00"),
]
cases << run("the third consecutive failed payout to a bank account pauses payouts and comments", seed: base_seed(
  payments: [payment_row(7)] + earlier_failures
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("a completed payout in between resets the failure count", seed: base_seed(
  payments: [payment_row(7)] + earlier_failures + [payment_row(10, state: "completed", created_at: "2025-10-09 10:00:00")]
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("transient and internal failures do not count toward the pause", seed: base_seed(
  payments: [payment_row(7)] + [
    payment_row(8, state: "failed", failure_reason: "processor_unavailable", created_at: "2025-10-01 10:00:00"),
    payment_row(9, state: "failed", failure_reason: "destination_ledger_negative", created_at: "2025-10-08 10:00:00"),
  ]
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("an already paused seller is not paused again", seed: base_seed(
  payments: [payment_row(7)] + earlier_failures,
  extra: { users: [user_row(5, flags: 1 << 19, json_data: '{"payouts_paused_by":"admin"}'), user_row(767_082, email: "admin@example.com", username: "admin")] }
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("a retired-account drain never trips the pause", seed: base_seed(
  payments: [payment_row(7, json_data: '{"retired_account_drain":true}')] + earlier_failures
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("failures counted by the Stripe payout destination when the payment has no bank account", seed: base_seed(
  payments: [payment_row(7, bank_account_id: nil, json_data: '{"stripe_payout_destination_id":"ba_dest"}')] + [
    payment_row(8, bank_account_id: nil, state: "failed", failure_reason: "account_closed", created_at: "2025-10-01 10:00:00", json_data: '{"stripe_payout_destination_id":"ba_dest"}'),
    payment_row(9, bank_account_id: nil, state: "failed", failure_reason: "account_closed", created_at: "2025-10-08 10:00:00", json_data: '{"stripe_payout_destination_id":"ba_dest"}'),
  ]
)) do
  Payment.find(7).mark_failed!("account_closed")
end

cases << run("a payment with no bank account and no destination is not counted", seed: base_seed(
  payments: [payment_row(7, bank_account_id: nil)] + earlier_failures.map { _1.merge(bank_account_id: nil) }
)) do
  Payment.find(7).mark_failed!("account_closed")
end

# Balance events.
cases << run("balance mark_unpaid! from processing", seed: base_seed(payments: [])) do
  Balance.find(1).mark_unpaid!
end

cases << run("balance mark_processing! then mark_paid!", seed: base_seed(payments: [], balances: [balance_row(1, state: "unpaid"), balance_row(2)])) do
  balance = Balance.find(1)
  balance.mark_processing!
  balance.mark_paid!
end

cases << run("balance mark_paid! from unpaid is not a transition", seed: base_seed(payments: [], balances: [balance_row(1, state: "unpaid"), balance_row(2)])) do
  Balance.find(1).mark_paid!
end

# Credit.create_for_returned_payment_difference!
cases << run("Credit.create_for_returned_payment_difference! writes the credit, its balance transaction and the balance", seed: base_seed(
  payments: [payment_row(7, state: "failed", currency: "eur")], balances: [balance_row(1, state: "unpaid", currency: "usd", holding_currency: "eur")]
)) do
  payment = Payment.find(7)
  Credit.create_for_returned_payment_difference!(user: payment.user, merchant_account: MerchantAccount.find(3), returned_payment: payment, difference_amount_cents: -137)
end

cases << run("Credit.create_for_returned_payment_difference! adds to the day's existing balance", seed: base_seed(
  payments: [payment_row(7, state: "failed", currency: "usd")], balances: [balance_row(1, state: "unpaid", date: "2025-11-01", amount_cents: 0, holding_amount_cents: 0)]
)) do
  payment = Payment.find(7)
  Credit.create_for_returned_payment_difference!(user: payment.user, merchant_account: MerchantAccount.find(3), returned_payment: payment, difference_amount_cents: 250)
end

# The reason tables the Node port reads (Payment::FailureReason), written beside the golden so they cannot drift from Ruby.
reasons = Payment::FailureReason
File.write(Rails.root.join("nextjs/src/server/models/payment-failure-reasons.generated.json"), JSON.pretty_generate(
  stripe_failure_solutions: reasons.const_get(:STRIPE_FAILURE_SOLUTIONS),
  transient_reasons: reasons::TRANSIENT_REASONS,
  internal_reconciliation_reasons: reasons::INTERNAL_RECONCILIATION_REASONS,
  terminal_paypal_failure_reasons: reasons::TERMINAL_PAYPAL_FAILURE_REASONS,
  explained_paypal_failure_reasons: reasons::EXPLAINED_PAYPAL_FAILURE_REASONS,
  unaccounted_money_reasons: reasons::UNACCOUNTED_MONEY_REASONS,
  requeueable_reasons: reasons::REQUEUEABLE_REASONS
) + "\n")

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : 'ok'}" }
