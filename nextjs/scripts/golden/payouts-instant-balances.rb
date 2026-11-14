# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-instant-balances.golden.json: User#instantly_payable_unpaid_balances (the balances an
# instant payout can claim, cut at the first date the seller's Stripe balance cannot cover once the fee is added) and
# StripePayoutProcessor.instantly_payable_amount_cents_on_stripe, run by the real models against a scratch database. Stripe is never
# reached: WebMock answers each request in order from the case's `http_responses`.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-instant-balances.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-instant-balances.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions payments balances bank_accounts merchant_accounts].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 15_000, holding_amount_cents: 15_000, state: "unpaid", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: "2025-10-25 01:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", stripe_connect_account_id: "acct_seller",
         stripe_bank_account_id: "ba_seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
CONNECT_ACCOUNT = STRIPE_ACCOUNT.merge(id: 4, charge_processor_merchant_id: "acct_connect", json_data: { meta: { stripe_connect: "true" } }.to_json).freeze
PAYPAL_ACCOUNT = { id: 6, user_id: 5, charge_processor_id: "paypal", charge_processor_merchant_id: "paypal_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze

def seed(balances:, banks: [BANK], accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT])
  { users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], balances:, bank_accounts: banks, merchant_accounts: accounts }
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400) = { status:, body: { error: { message:, type: "invalid_request_error" } }.to_json, headers: JSON_HEADERS }

# The instant-available amount Stripe reports for the seller's bank account.
def available(amount, destination: "ba_seller")
  ok(object: "balance", available: [], pending: [], instant_available: [{ amount:, currency: "usd", net_available: [{ amount:, destination:, source_types: {} }] }])
end

RESULT = {}

def run(name, seed:, http_responses: [], **extra)
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra) do
    user = User.find(5)
    RESULT[:cents_on_stripe] = StripePayoutProcessor.instantly_payable_amount_cents_on_stripe(user) if extra[:amount_only]
    RESULT[:ids] = user.instantly_payable_unpaid_balances.map(&:id) unless extra[:amount_only]
  end
  result.merge("balance_ids" => RESULT[:ids], "cents_on_stripe" => RESULT[:cents_on_stripe])
end

THREE = [
  balance_row(1, date: "2025-10-25", holding_amount_cents: 10_300),
  balance_row(2, date: "2025-10-26", holding_amount_cents: 20_600, created_at: "2025-10-26 01:00:00"),
  balance_row(3, date: "2025-10-27", holding_amount_cents: 30_900, created_at: "2025-10-27 01:00:00")
].freeze

cases = []

cases << run("Stripe covers every balance", seed: seed(balances: THREE), http_responses: [available(100_000)])
# 10_300 -> floor(10_300 * 100 / 103) = 10_000; 30_900 cumulative -> 30_000; 60_000 cumulative with the third -> 60_000
cases << run("Stripe covers the first two balances", seed: seed(balances: THREE), http_responses: [available(30_000)])
cases << run("Stripe covers the first balance only", seed: seed(balances: THREE), http_responses: [available(10_000)])
cases << run("Stripe covers one cent short of the first balance", seed: seed(balances: THREE), http_responses: [available(9_999)])
cases << run("Stripe reports nothing instant-available", seed: seed(balances: THREE), http_responses: [ok(object: "balance", available: [], pending: [])])
cases << run("Stripe reports an empty instant-available list", seed: seed(balances: THREE), http_responses: [ok(object: "balance", available: [], pending: [], instant_available: [])])
cases << run("Stripe reports another destination", seed: seed(balances: THREE), http_responses: [available(100_000, destination: "ba_other")])
cases << run("Stripe reports an instant-available entry without net amounts", seed: seed(balances: THREE),
             http_responses: [ok(object: "balance", available: [], pending: [], instant_available: [{ amount: 100_000, currency: "usd" }])])
cases << run("a seller with no bank account", seed: seed(balances: THREE, banks: []))
cases << run("Gumroad-held balances need no cover", seed: seed(balances: [balance_row(1, merchant_account_id: 2), balance_row(2, merchant_account_id: 2, date: "2025-10-26", created_at: "2025-10-26 01:00:00")]),
             http_responses: [available(0)])
cases << run("Gumroad-held and Stripe-held balances share the day", seed: seed(balances: [
  balance_row(1, holding_amount_cents: 10_300), balance_row(2, merchant_account_id: 2, holding_amount_cents: 5_000, created_at: "2025-10-25 02:00:00"),
  balance_row(3, date: "2025-10-26", holding_amount_cents: 20_600, created_at: "2025-10-26 01:00:00")
]), http_responses: [available(10_000)])
cases << run("a Stripe-held balance on a later date than the cover", seed: seed(balances: [
  balance_row(1, merchant_account_id: 2), balance_row(2, date: "2025-10-26", holding_amount_cents: 10_300, created_at: "2025-10-26 01:00:00")
]), http_responses: [available(9_000)])
cases << run("balances dated after today are not claimable", seed: seed(balances: [balance_row(1), balance_row(2, date: "2025-11-02", created_at: "2025-11-02 01:00:00")]),
             http_responses: [available(100_000)])
cases << run("a balance paid out already is left out", seed: seed(balances: [balance_row(1, state: "paid"), balance_row(2, date: "2025-10-26", created_at: "2025-10-26 01:00:00")]),
             http_responses: [available(100_000)])
cases << run("an unpaid balance after today still counts against the cover", seed: seed(balances: [balance_row(1, holding_amount_cents: 10_300), balance_row(2, date: "2025-11-02", holding_amount_cents: 10_300, created_at: "2025-11-02 01:00:00")]),
             http_responses: [available(10_000)])
cases << run("two Stripe-held balances on one date", seed: seed(balances: [balance_row(1, holding_amount_cents: 10_300), balance_row(2, holding_amount_cents: 10_300, created_at: "2025-10-25 02:00:00")]),
             http_responses: [available(15_000)])
cases << run("a balance held by a Connect account is not instant-payable", seed: seed(balances: [balance_row(1), balance_row(2, merchant_account_id: 4, date: "2025-10-26", created_at: "2025-10-26 01:00:00")], accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT, CONNECT_ACCOUNT]),
             http_responses: [available(100_000)])
cases << run("a balance on a PayPal account is not instant-payable", seed: seed(balances: [balance_row(1), balance_row(2, merchant_account_id: 6, date: "2025-10-26", created_at: "2025-10-26 01:00:00")], accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT, PAYPAL_ACCOUNT]),
             http_responses: [available(100_000)])
cases << run("a negative balance counts against the cover", seed: seed(balances: [balance_row(1, holding_amount_cents: 20_600), balance_row(2, date: "2025-10-26", holding_amount_cents: -10_300, created_at: "2025-10-26 01:00:00")]),
             http_responses: [available(10_000)])
cases << run("Stripe fails with a server error", seed: seed(balances: THREE), http_responses: [refused("An error occurred on our side.", status: 500)] * 4)
cases << run("Stripe refuses the read", seed: seed(balances: THREE), http_responses: [refused("Some refusal.")])
cases << run("the cover read alone, from Stripe's answer", seed: seed(balances: []), http_responses: [available(12_345)], amount_only: true)

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : c['balance_ids'].inspect + c['cents_on_stripe'].inspect} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
