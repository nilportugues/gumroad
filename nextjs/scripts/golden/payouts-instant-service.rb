# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-instant-service.golden.json: InstantPayoutsService#perform end to end (the
# eligibility read, the balances an instant payout can claim, the minimum and maximum, Payouts.create_payments with the instant payout type,
# StripePayoutProcessor.process_payments and the answer), run by the real classes against a scratch database. Stripe is never reached:
# WebMock answers each request in order from the case's `http_responses`, and `http` lists what Rails sent with the number of statements
# before each request.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-instant-service.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-instant-service.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
REQUEST_DATE = Date.new(2025, 11, 1)
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions user_compliance_info seller_profiles links].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

# `sleep(2)` between the destination charge lookups: recorded, not slept.
SLEEPS = []
StripePayoutProcessor.singleton_class.prepend(Module.new { define_method(:sleep) { |seconds| SLEEPS << seconds } })

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: "{}", confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 15_000, holding_amount_cents: 15_000, state: "unpaid", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: "2025-10-25 01:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, **overrides)
  { id:, user_id: 5, state: "completed", processor: "STRIPE", amount_cents: 1000, payout_period_end_date: "2025-09-30", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: nil, created_at: "2025-10-01 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", stripe_connect_account_id: "acct_seller",
         stripe_bank_account_id: "ba_seller", state: "unverified", bank_number: "110000000", account_type: "checking", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
INFO = { id: 1, user_id: 5, country: "United States", is_business: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze

def seed(balances:, users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], banks: [BANK], payments: [payment_row(1)])
  { users:, payments:, balances:, bank_accounts: banks, merchant_accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT], user_compliance_info: [INFO] }
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400, code: nil) = { status:, body: { error: { message:, code:, type: "invalid_request_error" }.compact }.to_json, headers: JSON_HEADERS }
DROPPED = { dropped: true }.freeze

def external_account(*methods) = ok(id: "ba_seller", object: "bank_account", available_payout_methods: methods)
def instant_available(amount) = ok(object: "balance", available: [], pending: [], instant_available: [{ amount:, currency: "usd", net_available: [{ amount:, destination: "ba_seller", source_types: {} }] }])
def stripe_balance(available:, pending: 0) = ok(object: "balance", available: [{ amount: available, currency: "usd" }], pending: [{ amount: pending, currency: "usd" }])
def payout(amount, **overrides) = ok({ id: "po_one", object: "payout", amount:, arrival_date: 1_762_300_000, currency: "usd", application_fee_amount: (amount * 3 / 100.0).floor }.merge(overrides))
def internal_transfer(amount) = ok(id: "tr_internal", object: "transfer", amount:, amount_reversed: 0, currency: "usd", destination: "acct_seller", destination_payment: "py_internal")

def destination_charge(amount)
  ok(id: "py_internal", object: "charge", amount:, currency: "usd", balance_transaction: { id: "txn_destination", object: "balance_transaction", amount:, net: amount, currency: "usd" })
end

def reversal_answers(amount)
  [ok(id: "tr_internal", object: "transfer", amount:, amount_reversed: 0, currency: "usd", destination: "acct_seller", destination_payment: "py_internal",
      reversals: { object: "list", data: [], has_more: false, url: "/v1/transfers/tr_internal/reversals" }),
   ok(id: "trr_one", object: "transfer_reversal", amount:, transfer: "tr_internal"),
   ok(id: "py_internal", object: "charge", amount:, currency: "usd", balance_transaction: { id: "txn_destination", object: "balance_transaction", amount:, net: amount, currency: "usd" },
      refunds: { object: "list", has_more: false, data: [{ id: "re_one", object: "refund", balance_transaction: "txn_refund" }] }),
   ok(id: "txn_refund", object: "balance_transaction", amount: -amount, net: -amount, currency: "usd")]
end

# The reads every request makes first: the bank account's payout methods, then what Stripe can cover instantly.
def reads(cover: 1_000_000_00) = [external_account("standard", "instant"), instant_available(cover)]

RESULT = {}

def run(name, seed:, http_responses:, date: REQUEST_DATE, **extra)
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra) do
    RESULT[:result] = InstantPayoutsService.new(User.find(5), date:).perform
  end
  payment = Payment.where(user_id: 5).order(:id).last
  result.merge("result" => RESULT[:result], "date" => date.to_s, "sleeps" => SLEEPS.dup, "payment" => payment&.attributes&.slice("id", "state", "failure_reason", "stripe_transfer_id", "stripe_internal_transfer_id", "amount_cents"))
        .tap { SLEEPS.clear }
end

ONE = [balance_row(1, holding_amount_cents: 10_000, amount_cents: 10_000)].freeze
TWO = [
  balance_row(1, holding_amount_cents: 10_000, amount_cents: 10_000),
  balance_row(2, date: "2025-10-26", holding_amount_cents: 5_000, amount_cents: 5_000, created_at: "2025-10-26 01:00:00")
].freeze
GUMROAD_HELD = balance_row(3, merchant_account_id: 2, date: "2025-10-27", holding_amount_cents: 20_000, amount_cents: 20_000, created_at: "2025-10-27 01:00:00")

# 10_000 cents at 3% leaves floor(10_000 * 100 / 103) = 9_708 to pay out; the drift read and the payout follow the two reads.
PAYOUT_ONE = 9_708
PAYOUT_TWO = 14_563

cases = []

cases << run("an instant payout for one Stripe-held balance", seed: seed(balances: ONE),
             http_responses: reads + [stripe_balance(available: 1_000_000_00), payout(PAYOUT_ONE)])
cases << run("an instant payout for two Stripe-held balances", seed: seed(balances: TWO),
             http_responses: reads + [stripe_balance(available: 1_000_000_00), payout(PAYOUT_TWO)])
cases << run("an instant payout for balances held by Stripe and Gumroad", seed: seed(balances: ONE + [GUMROAD_HELD]),
             http_responses: reads + [stripe_balance(available: 1_000_000_00), internal_transfer(20_000), destination_charge(20_000), payout(29_126)])
cases << run("an instant payout for a balance held by Gumroad alone", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: reads(cover: 0) + [internal_transfer(20_000), destination_charge(20_000), payout(19_417)])
cases << run("a bank account that takes standard payouts only", seed: seed(balances: ONE), http_responses: [external_account("standard")])
cases << run("a seller who is not compliant", seed: seed(balances: ONE, users: [user_row(5, user_risk_state: "not_reviewed"), user_row(767_082, email: "admin@example.com", username: "admin")]), http_responses: [])
cases << run("a seller with no completed payout", seed: seed(balances: ONE, payments: []), http_responses: [])
cases << run("a seller with no bank account", seed: seed(balances: ONE, banks: []), http_responses: [])
cases << run("Stripe fails the payout-methods read", seed: seed(balances: ONE), http_responses: [refused("An error occurred on our side.", status: 500)] * 4)
cases << run("Stripe fails the instant-available read", seed: seed(balances: ONE), http_responses: [external_account("standard", "instant")] + [refused("An error occurred on our side.", status: 500)] * 4)
cases << run("balances under the minimum", seed: seed(balances: [balance_row(1, holding_amount_cents: 99, amount_cents: 99)]), http_responses: reads)
cases << run("a seller with no balance", seed: seed(balances: []), http_responses: reads)
cases << run("Stripe cannot cover the balance", seed: seed(balances: ONE), http_responses: reads(cover: 100))
cases << run("a request dated before the balance", seed: seed(balances: ONE), http_responses: reads, date: Date.new(2025, 10, 24))
cases << run("a balance over the maximum", seed: seed(balances: [balance_row(1, holding_amount_cents: 10_000_00, amount_cents: 10_000_00)]), http_responses: reads)
cases << run("a negative ledger is withheld", seed: seed(balances: ONE + [balance_row(2, date: "2025-10-26", holding_amount_cents: -20_000, amount_cents: -20_000, created_at: "2025-10-26 01:00:00")]),
             http_responses: reads)

{
  "an account without the funds" => [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")],
  "an account that cannot be paid" => [refused("Cannot create payouts; your account has outstanding requirements.")],
  "a debit card over the limit" => [refused("Debit card transfers are only supported for amounts less than $3,000.00.")],
  "a bank account Stripe cannot find" => [refused("No such external account: 'ba_seller'", status: 404)],
  "a rate limit" => [{ status: 429, body: { error: { message: "Too many requests", type: "rate_limit_error" } }.to_json, headers: JSON_HEADERS }],
  "an error no reason covers" => [refused("Something unexpected")],
  "a server error" => [refused("Server trouble", status: 500)] * 4,
  "a dropped connection" => [DROPPED] * 4,
}.each do |label, answers|
  cases << run("Stripe answers the payout with #{label}", seed: seed(balances: ONE), http_responses: reads + [stripe_balance(available: 1_000_000_00)] + answers)
end

cases << run("the payout fails after the internal transfer and the transfer is reversed", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: reads(cover: 0) + [internal_transfer(20_000), destination_charge(20_000),
                                                 refused("Cannot create payouts; your account has outstanding requirements.")] + reversal_answers(20_000))
cases << run("the connection drops on the payout after the internal transfer", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: reads(cover: 0) + [internal_transfer(20_000), destination_charge(20_000)] + [DROPPED] * 4 + reversal_answers(20_000))
cases << run("Stripe refuses the internal transfer", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: reads(cover: 0) + [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")])

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : c['result'].inspect} #{c['payment']&.slice('state', 'failure_reason').inspect} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
