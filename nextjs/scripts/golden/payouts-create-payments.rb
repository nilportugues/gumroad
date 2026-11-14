# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-create-payments.golden.json: Payouts.create_payments (the claim of the
# unpaid balances under the seller lock, the ledger checks, the Payment rows and their payments_balances) and the user hold of
# StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts! / hold_payouts_for_unaccounted_money!, run by the real models
# against a scratch database. Stripe is never reached: `prepare_payment_and_set_amount` is replaced by a stub that records its
# arguments (and raises when a case asks it to), and every outbound request is answered by WebMock with an empty object.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-create-payments.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-create-payments.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
PAYOUT_DATE = Date.new(2025, 10, 31)
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions seller_profiles links user_compliance_info user_compliance_info_requests].freeze

# What the stubbed `prepare_payment_and_set_amount` saw, and what a case wants it to do.
module PrepareStub
  class << self
    attr_accessor :calls, :behaviour
  end
  self.calls = []
end

StripePayoutProcessor.singleton_class.prepend(Module.new do
  def prepare_payment_and_set_amount(payment, balances, merchant_account = nil, payout_currency = nil)
    PrepareStub.calls << { "payment_id" => payment.id, "balance_ids" => balances.map(&:id), "merchant_account_id" => merchant_account&.id, "payout_currency" => payout_currency }
    case PrepareStub.behaviour
    when :raise then raise "stripe is unreachable"
    when :fail
      payment.mark_failed!(Payment::FailureReason::CANNOT_PAY)
      ["failed"]
    else []
    end
  end
end)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 15_000, holding_amount_cents: 15_000, state: "unpaid", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, **overrides)
  { id:, user_id: 5, state: "processing", processor: "STRIPE", amount_cents: 1000, payout_period_end_date: "2025-10-31", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: nil, created_at: "2025-10-31 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze

def seed(balances: [balance_row(1)], payments: [], users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], extra: {})
  { users:, balances:, payments:, bank_accounts: [BANK], merchant_accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT] }.merge(extra)
end

def run(name, seed:, prepare: nil, **extra, &block)
  PrepareStub.calls = []
  PrepareStub.behaviour = prepare
  result = capture(name, now: NOW, tables: TABLES, seed:, **extra, &block)
  result.merge("prepare_calls" => PrepareStub.calls.dup)
end

def seller = User.find(5)

cases = []

cases << run("one payable Stripe-held balance becomes one processing payment", seed: seed) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("two balances share one payment", seed: seed(balances: [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: 7000, holding_amount_cents: 7000)])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a balance dated after the payout date is not claimed", seed: seed(balances: [balance_row(1), balance_row(2, date: "2025-11-01")])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a seller with no unpaid balance gets no payment", seed: seed(balances: [balance_row(1, state: "paid")])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a paused seller is not claimed", seed: seed(users: [user_row(5, flags: 1 << 19, json_data: '{"payouts_paused_by":"admin"}'), user_row(767_082, email: "admin@example.com", username: "admin")])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("an instant payout records its payout type", seed: seed) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller, payout_type: Payouts::PAYOUT_TYPE_INSTANT)
end

cases << run("Gumroad-held balances join the seller's own group", seed: seed(balances: [balance_row(1), balance_row(2, merchant_account_id: 2, date: "2025-10-26", amount_cents: 2500, holding_amount_cents: 2500)])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a negative ledger is withheld and noted once", seed: seed(balances: [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: -20_000, holding_amount_cents: -20_000)])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a negative ledger already noted adds no second note", seed: seed(
  balances: [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: -20_000, holding_amount_cents: -20_000)],
  extra: { comments: [{ id: 1, commentable_id: 5, commentable_type: "User", author_id: GUMROAD_ADMIN_ID, comment_type: "payout_note",
                        content: "Payout STRIPE withheld for ledger x because the unpaid ledger is not payable. Reconcile the unpaid balance ledger before retry.",
                        json_data: { ledger_hold_debt_keys: ["b2"], ledger_hold_notification_state: "notified", ledger_hold_claimed_at: "2025-10-31T00:00:00Z" }.to_json,
                        created_at: "2025-10-31 00:00:00", updated_at: "2025-10-31 00:00:00" }] }
)) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

# A hold note some other run claimed but never finished reporting: stale, failed, or still fresh.
def held_note(state, claimed_at)
  { comments: [{ id: 1, commentable_id: 5, commentable_type: "User", author_id: GUMROAD_ADMIN_ID, comment_type: "payout_note",
                 content: "Payout STRIPE withheld for ledger x because the unpaid ledger is not payable. Reconcile the unpaid balance ledger before retry.",
                 json_data: { ledger_hold_debt_keys: ["b2"], ledger_hold_notification_state: state, ledger_hold_claimed_at: claimed_at }.to_json,
                 created_at: "2025-10-31 00:00:00", updated_at: "2025-10-31 00:00:00" }] }
end

[["a negative ledger whose note was claimed long ago is claimed and reported again", "claimed", "2025-11-01T12:00:00Z"],
 ["a negative ledger whose note was claimed a moment ago is left alone", "claimed", "2025-11-01T12:20:00Z"],
 ["a negative ledger whose note failed to report is claimed and reported again", "failed", "2025-11-01T12:20:00Z"],
 ["a negative ledger whose note was reported is left alone", "notified", "2025-11-01T12:00:00Z"]].each do |name, state, claimed_at|
  cases << run(name, seed: seed(balances: [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: -20_000, holding_amount_cents: -20_000)], extra: held_note(state, claimed_at))) do
    Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
  end
end

cases << run("a group the claim leaves non-positive is released", seed: seed(balances: [balance_row(1, amount_cents: 0, holding_amount_cents: 0), balance_row(2, date: "2025-10-26", amount_cents: 0, holding_amount_cents: 0)])) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a processor error fails the payment as processor_unavailable", seed: seed, prepare: :raise) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("a payment the processor already failed is not marked processing", seed: seed, prepare: :fail) do
  Payouts.create_payments(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

cases << run("create_payment returns the single payment", seed: seed) do
  Payouts.create_payment(PAYOUT_DATE, PayoutProcessorType::STRIPE, seller)
end

# The user hold of reverse_internal_transfer_or_hold_payouts! with no internal transfer to reverse.
cases << run("a payout outcome unknown holds payouts and comments", seed: seed(payments: [payment_row(7, state: "failed", failure_reason: "payout_outcome_unknown")])) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
end

cases << run("a processor_unavailable failure with no internal transfer holds nothing", seed: seed(payments: [payment_row(7, state: "failed", failure_reason: "processor_unavailable")])) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), Payment::FailureReason::PROCESSOR_UNAVAILABLE)
end

cases << run("the hold comment is written even when the seller is already paused", seed: seed(
  payments: [payment_row(7, state: "failed", failure_reason: "payout_outcome_unknown")],
  users: [user_row(5, flags: 1 << 19, json_data: '{"payouts_paused_by":"admin"}'), user_row(767_082, email: "admin@example.com", username: "admin")]
)) do
  StripePayoutProcessor.send(:hold_payouts_for_unaccounted_money!, Payment.find(7), Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
end

cases << run("the hold comment is not repeated for the same payout", seed: seed(
  payments: [payment_row(7, state: "failed", failure_reason: "payout_outcome_unknown")]
)) do
  payment = Payment.find(7)
  StripePayoutProcessor.send(:hold_payouts_for_unaccounted_money!, payment, Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
  StripePayoutProcessor.send(:hold_payouts_for_unaccounted_money!, payment, Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
end

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : 'ok'} (#{c['statements'].size} statements)" }
