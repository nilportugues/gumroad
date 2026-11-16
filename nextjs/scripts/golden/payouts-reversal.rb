# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-reversal.golden.json: the reversal of a failed payout's internal transfer
# (StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!, reverse_internal_transfer_or_defer!, reverse_internal_transfer!
# and the difference credit), run by the real models against a scratch database. Stripe is never reached: WebMock answers each
# request in order from the case's `http_responses`, and the `http` of a case lists what Rails sent (method, url, body, headers).
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-reversal.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-reversal.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions user_compliance_info].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

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
  { id:, user_id: 5, state: "failed", processor: "STRIPE", amount_cents: 1000, payout_period_end_date: "2025-10-31", currency: "usd",
    stripe_connect_account_id: "acct_seller", stripe_internal_transfer_id: "tr_one", failure_reason: "processor_unavailable", bank_account_id: 11, flags: 0,
    json_data: nil, created_at: "2025-10-31 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze

def seed(payments: [payment_row(7)], extra: {})
  { users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], balances: [balance_row(1)], payments:,
    bank_accounts: [BANK], merchant_accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT] }.merge(extra)
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400) = { status:, body: { error: { message:, type: "invalid_request_error" } }.to_json, headers: JSON_HEADERS }

def transfer(amount_reversed: 0)
  ok(id: "tr_one", object: "transfer", amount: 100_000, amount_reversed:, currency: "usd", destination: "acct_seller", destination_payment: "py_one",
     reversals: { object: "list", data: [], has_more: false, url: "/v1/transfers/tr_one/reversals" })
end

REVERSAL = ok(id: "trr_one", object: "transfer_reversal", amount: 100_000, transfer: "tr_one")

def charge(refunded: true, net: 100_000)
  ok(id: "py_one", object: "charge", amount: 100_000, currency: "usd",
     balance_transaction: { id: "txn_destination", object: "balance_transaction", amount: net, net:, currency: "usd" },
     refunds: { object: "list", has_more: false, data: refunded ? [{ id: "re_one", object: "refund", balance_transaction: "txn_refund" }] : [] })
end

def refund_transaction(net) = ok(id: "txn_refund", object: "balance_transaction", amount: net, net:, currency: "usd")

def run(name, seed:, http_responses: [], **extra, &block)
  capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra, &block)
end

REASON_UNKNOWN = Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN
REASON_UNAVAILABLE = Payment::FailureReason::PROCESSOR_UNAVAILABLE

cases = []

cases << run("a reversal with no difference writes nothing", seed: seed,
             http_responses: [transfer, REVERSAL, charge, refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a reversal short of the transfer is covered by a credit", seed: seed,
             http_responses: [transfer, REVERSAL, charge(net: 99_000), refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a reversal that returns more than the transfer credits the seller", seed: seed,
             http_responses: [transfer, REVERSAL, charge(net: 100_000), refund_transaction(-98_500)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a transfer that is already reversed is not reversed again", seed: seed,
             http_responses: [transfer(amount_reversed: 100_000), charge(net: 99_000), refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a difference credit already recorded ends the reversal after the transfer call", seed: seed(
  extra: { credits: [{ id: 1, user_id: 5, merchant_account_id: 3, amount_cents: 0, returned_payment_id: 7, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
), http_responses: [transfer(amount_reversed: 100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("an unknown payout outcome is reversed and then held", seed: seed(payments: [payment_row(7, failure_reason: REASON_UNKNOWN)]),
             http_responses: [transfer, REVERSAL, charge, refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNKNOWN)
end

cases << run("a reversal Stripe refuses stamps the payment and holds the seller", seed: seed,
             http_responses: [refused("No such transfer: 'tr_one'", status: 404)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a reversal Stripe refuses raises when the caller asks to reraise", seed: seed,
             http_responses: [refused("No such transfer: 'tr_one'", status: 404)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE, reraise: true)
end

cases << run("a refused reversal keeps the unknown outcome reason", seed: seed(payments: [payment_row(7, failure_reason: REASON_UNKNOWN)]),
             http_responses: [refused("No such transfer: 'tr_one'", status: 404)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNKNOWN)
end

cases << run("a destination charge without a refund fails the reversal after the transfer was reversed", seed: seed,
             http_responses: [transfer, REVERSAL, charge(refunded: false)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

# A sibling payout awaiting its bank payout defers the reversal, but only for a cross-border seller; a United States seller
# (the only kind that can ask for an instant payout) reverses at once.
SIBLING = payment_row(8, state: "processing", stripe_internal_transfer_id: "tr_two", stripe_transfer_id: nil, failure_reason: nil, created_at: "2025-11-01 11:00:00")
COMPLIANCE = lambda do |country|
  { id: 1, user_id: 5, country:, business_country: country, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

cases << run("a sibling payout awaiting its bank payout does not defer a United States seller", seed: seed(
  payments: [payment_row(7), SIBLING], extra: { user_compliance_info: [COMPLIANCE.call("United States")] }
), http_responses: [transfer, REVERSAL, charge, refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

cases << run("a payment with no sibling reverses at once", seed: seed(payments: [payment_row(7), payment_row(8, state: "completed", stripe_transfer_id: "po_x")]),
             http_responses: [transfer, REVERSAL, charge, refund_transaction(-100_000)]) do
  StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!(Payment.find(7), REASON_UNAVAILABLE)
end

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : 'ok'} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
