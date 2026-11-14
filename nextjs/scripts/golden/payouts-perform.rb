# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-perform.golden.json: StripePayoutProcessor.process_payments and perform_payment
# (the payout request to the seller's bank account and what it records, and every failure branch with the bank account deletion, the
# reversal of the internal transfer and the hold they trigger), run by the real models against a scratch database. Stripe is never
# reached: WebMock answers each request in order from the case's `http_responses`; `http` lists what Rails sent with the number of
# statements before it.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-perform.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-perform.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions user_compliance_info seller_profiles links].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

# `sleep(2)` between the destination charge lookups: recorded, not slept.
SLEEPS = []
StripePayoutProcessor.singleton_class.prepend(Module.new { define_method(:sleep) { |seconds| SLEEPS << seconds } })

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 15_000, holding_amount_cents: 15_000, state: "processing", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, **overrides)
  { id:, user_id: 5, state: "processing", processor: "STRIPE", amount_cents: 21_359, payout_period_end_date: "2025-10-31", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: { payout_type: "instant" }.to_json, created_at: "2025-10-31 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", stripe_connect_account_id: "acct_seller", stripe_bank_account_id: "ba_seller", state: "unverified", bank_number: "110000000", account_type: "checking",
         created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
RETIRED_ACCOUNT = STRIPE_ACCOUNT.merge(id: 4, charge_processor_merchant_id: "acct_retired", deleted_at: SEEDED_AT, charge_processor_deleted_at: SEEDED_AT).freeze

def seed(balances:, payment: payment_row(7), accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT], extra: {})
  { users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], balances:, payments: [payment],
    payments_balances: balances.map { { payment_id: payment[:id], balance_id: _1[:id] } }, bank_accounts: [BANK], merchant_accounts: accounts }.merge(extra)
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400, code: nil) = { status:, body: { error: { message:, code:, type: "invalid_request_error" }.compact }.to_json, headers: JSON_HEADERS }
def rate_limited = { status: 429, body: { error: { message: "Too many requests", type: "rate_limit_error" } }.to_json, headers: JSON_HEADERS }
DROPPED = { dropped: true }.freeze

def stripe_balance(available:, pending: 0, currency: "usd")
  ok(object: "balance", available: [{ amount: available, currency: }], pending: [{ amount: pending, currency: }])
end

def internal_transfer = ok(id: "tr_internal", object: "transfer", amount: 100_000, amount_reversed: 0, currency: "usd", destination: "acct_seller", destination_payment: "py_internal")

def destination_charge(amount: 100_000, ready: true)
  ok(id: "py_internal", object: "charge", amount: 100_000, currency: "usd",
     balance_transaction: ready ? { id: "txn_destination", object: "balance_transaction", amount:, net: amount, currency: "usd" } : nil)
end

# The reversal that follows a failure after the internal transfer: the transfer, its reversal, the destination charge and its refund.
def reversal_answers
  [ok(id: "tr_internal", object: "transfer", amount: 100_000, amount_reversed: 0, currency: "usd", destination: "acct_seller", destination_payment: "py_internal",
      reversals: { object: "list", data: [], has_more: false, url: "/v1/transfers/tr_internal/reversals" }),
   ok(id: "trr_one", object: "transfer_reversal", amount: 100_000, transfer: "tr_internal"),
   ok(id: "py_internal", object: "charge", amount: 100_000, currency: "usd", balance_transaction: { id: "txn_destination", object: "balance_transaction", amount: 100_000, net: 100_000, currency: "usd" },
      refunds: { object: "list", has_more: false, data: [{ id: "re_one", object: "refund", balance_transaction: "txn_refund" }] }),
   ok(id: "txn_refund", object: "balance_transaction", amount: -100_000, net: -100_000, currency: "usd")]
end


def payout(**overrides) = ok({ id: "po_one", object: "payout", amount: 21_359, arrival_date: 1_762_300_000, currency: "usd", application_fee_amount: 641 }.merge(overrides))

# The transfer the prepare step made for Gumroad-held money, reversed when the payout fails.
def reversal_answers(refund_net: -100_000)
  [ok(id: "tr_internal", object: "transfer", amount: 100_000, amount_reversed: 0, currency: "usd", destination: "acct_seller", destination_payment: "py_internal",
      reversals: { object: "list", data: [], has_more: false, url: "/v1/transfers/tr_internal/reversals" }),
   ok(id: "trr_one", object: "transfer_reversal", amount: 100_000, transfer: "tr_internal"),
   ok(id: "py_internal", object: "charge", amount: 100_000, currency: "usd", balance_transaction: { id: "txn_destination", object: "balance_transaction", amount: 100_000, net: 100_000, currency: "usd" },
      refunds: { object: "list", has_more: false, data: [{ id: "re_one", object: "refund", balance_transaction: "txn_refund" }] }),
   ok(id: "txn_refund", object: "balance_transaction", amount: refund_net, net: refund_net, currency: "usd")]
end

RESULT = {}

def run(name, seed:, http_responses: [], **extra)
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra) do
    payment = Payment.find(7)
    RESULT[:payment] = payment
    begin
      StripePayoutProcessor.process_payments([payment])
    ensure
      RESULT[:attributes] = payment.attributes.slice("state", "amount_cents", "currency", "stripe_connect_account_id", "stripe_internal_transfer_id", "stripe_transfer_id", "failure_reason", "bank_account_id")
                                   .merge("error_message" => payment.error_message, "arrival_date" => payment.arrival_date, "gumroad_fee_cents" => payment.gumroad_fee_cents)
    end
  end
  result.merge("payment" => RESULT[:attributes])
end

STRIPE_HELD = [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: 7000, holding_amount_cents: 7000)].freeze
GUMROAD_HELD = balance_row(3, merchant_account_id: 2, date: "2025-10-27", amount_cents: 100_000, holding_amount_cents: 100_000)
GUMROAD_PAYMENT = payment_row(7, stripe_internal_transfer_id: "tr_internal")

cases = []

cases << run("a standard payout names the bank account and records the Stripe payout", seed: seed(balances: STRIPE_HELD, payment: payment_row(7, json_data: { payout_type: "standard" }.to_json)),
             http_responses: [payout(application_fee_amount: nil)])

cases << run("an instant payout records the fee Stripe took", seed: seed(balances: STRIPE_HELD), http_responses: [payout])

cases << run("a payout with no payout type sends no method", seed: seed(balances: STRIPE_HELD, payment: payment_row(7, json_data: nil)), http_responses: [payout(application_fee_amount: nil)])

{
  "an account without the funds" => [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")],
  "an account that cannot be paid" => [refused("Cannot create payouts; your account has outstanding requirements.")],
  "a debit card over the limit" => [refused("Debit card transfers are only supported for amounts less than $3,000.00.")],
  "an amount below the minimum" => [refused("Amount must be no less than $1.00.")],
  "an account Stripe froze" => [refused("This account requires further intervention before it can be paid.")],
  "a destination in another currency" => [refused("Attempting to create a transfer of eur to a destination that supports usd.")],
  "a bank account Stripe cannot find" => [refused("No such external account: 'ba_seller'", status: 404)],
  "an error that names no reason" => [refused("Something unexpected")],
  "a rate limit" => [rate_limited],
  "a server error" => [refused("Server trouble", status: 500)] * 4,
  "a dropped connection" => [DROPPED] * 4,
}.each do |label, answers|
  cases << run("Stripe refuses the bank payout: #{label}", seed: seed(balances: STRIPE_HELD), http_responses: answers)
end

cases << run("a payout that fails after the internal transfer is reversed: cannot be paid", seed: seed(balances: [GUMROAD_HELD], payment: GUMROAD_PAYMENT),
             http_responses: [refused("Cannot create payouts; your account has outstanding requirements.")] + reversal_answers)

cases << run("a payout that fails after the internal transfer is reversed with a credit for the difference", seed: seed(balances: [GUMROAD_HELD], payment: GUMROAD_PAYMENT),
             http_responses: [refused("Debit card transfers are only supported for amounts less than $3,000.00.")] + reversal_answers(refund_net: -98_500))

cases << run("a dropped connection after the internal transfer is reversed and then held", seed: seed(balances: [GUMROAD_HELD], payment: GUMROAD_PAYMENT),
             http_responses: [DROPPED] * 4 + reversal_answers)

cases << run("a reversal that fails keeps the payout failed, holds the seller and raises", seed: seed(balances: [GUMROAD_HELD], payment: GUMROAD_PAYMENT),
             http_responses: [refused("Cannot create payouts; your account has outstanding requirements."), refused("No such transfer: 'tr_internal'", status: 404)])

cases << run("a bank account Stripe cannot find is deleted before the transfer is reversed", seed: seed(balances: [GUMROAD_HELD], payment: GUMROAD_PAYMENT),
             http_responses: [refused("No such external account: 'ba_seller'", status: 404)] + reversal_answers)

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error']['class'] : 'ok'} #{c['payment']&.slice('state', 'failure_reason', 'stripe_transfer_id').inspect} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
