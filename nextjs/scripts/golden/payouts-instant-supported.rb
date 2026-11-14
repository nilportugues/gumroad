# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-instant-supported.golden.json: User#instant_payouts_supported? (compliance, pause,
# a completed payout, the seasoning of the destination accounts, the legal entity's country and the Stripe read of the bank account's
# payout methods), run by the real models against a scratch database. Stripe is never reached: WebMock answers each request in order from
# the case's `http_responses`.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-instant-supported.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-instant-supported.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions payments balances bank_accounts merchant_accounts user_compliance_info].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  { id:, user_id: 5, date: "2025-10-25", amount_cents: 15_000, holding_amount_cents: 15_000, state: "unpaid", merchant_account_id: 3,
    currency: "usd", holding_currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, **overrides)
  { id:, user_id: 5, state: "completed", processor: "STRIPE", amount_cents: 1000, payout_period_end_date: "2025-09-30", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: nil, created_at: "2025-10-01 10:00:00", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", stripe_connect_account_id: "acct_seller",
         stripe_bank_account_id: "ba_seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
STRIPE_ACCOUNT = { id: 3, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", currency: "usd", country: "US",
                   created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
GUMROAD_ACCOUNT = { id: 2, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", currency: "usd", country: "US",
                    created_at: SEEDED_AT, updated_at: SEEDED_AT, charge_processor_alive_at: SEEDED_AT }.freeze
YOUNG_ACCOUNT = STRIPE_ACCOUNT.merge(created_at: "2025-10-20 00:00:00").freeze
PREDECESSOR = STRIPE_ACCOUNT.merge(id: 4, charge_processor_merchant_id: "acct_old", deleted_at: "2025-10-19 00:00:00", charge_processor_deleted_at: "2025-10-19 00:00:00").freeze
NEVER_CARRIED = PREDECESSOR.merge(id: 5, charge_processor_merchant_id: "acct_never", charge_processor_alive_at: nil, charge_processor_deleted_at: nil).freeze
REJECTED = PREDECESSOR.merge(id: 6, charge_processor_merchant_id: "acct_rejected", json_data: { stripe_disabled_reason: "rejected.fraud" }.to_json).freeze
CONNECT_PREDECESSOR = PREDECESSOR.merge(id: 7, charge_processor_merchant_id: "acct_connect", json_data: { meta: { stripe_connect: "true" } }.to_json).freeze
INFO = { id: 1, user_id: 5, country: "United States", is_business: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze

def seed(users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], payments: [payment_row(1)], balances: [],
         accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT], banks: [BANK], infos: [INFO])
  { users:, payments:, balances:, bank_accounts: banks, merchant_accounts: accounts, user_compliance_info: infos }
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400) = { status:, body: { error: { message:, type: "invalid_request_error" } }.to_json, headers: JSON_HEADERS }
def external_account(*methods) = ok(id: "ba_seller", object: "bank_account", available_payout_methods: methods)

INSTANT = [external_account("standard", "instant")].freeze
RESULT = {}

def run(name, seed:, http_responses: [], **extra)
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra) do
    RESULT[:supported] = User.find(5).instant_payouts_supported?
  end
  result.merge("supported" => RESULT[:supported])
end

cases = []

cases << run("a seasoned seller whose bank account takes instant payouts", seed: seed, http_responses: INSTANT)
cases << run("a bank account that takes standard payouts only", seed: seed, http_responses: [external_account("standard")])
cases << run("a seller who is not compliant", seed: seed(users: [user_row(5, user_risk_state: "not_reviewed"), user_row(767_082, email: "admin@example.com", username: "admin")]))
cases << run("a seller whose payouts are paused internally", seed: seed(users: [user_row(5, flags: 1 << 19, json_data: '{"payouts_paused_by":"admin"}'), user_row(767_082, email: "admin@example.com", username: "admin")]))
cases << run("a seller whose payouts the seller paused", seed: seed(users: [user_row(5, flags: 1 << 40), user_row(767_082, email: "admin@example.com", username: "admin")]))
cases << run("a seller with no completed payout", seed: seed(payments: [payment_row(1, state: "failed")]))
cases << run("an account younger than the seasoning period", seed: seed(accounts: [GUMROAD_ACCOUNT, YOUNG_ACCOUNT]))
cases << run("a young account that inherits seasoning from a retired predecessor", seed: seed(accounts: [GUMROAD_ACCOUNT, YOUNG_ACCOUNT, PREDECESSOR]), http_responses: INSTANT)
cases << run("a young account whose predecessor never carried money", seed: seed(accounts: [GUMROAD_ACCOUNT, YOUNG_ACCOUNT, NEVER_CARRIED]))
cases << run("a young account whose predecessor was rejected", seed: seed(accounts: [GUMROAD_ACCOUNT, YOUNG_ACCOUNT, REJECTED]))
cases << run("a young account whose predecessor was a Connect account", seed: seed(accounts: [GUMROAD_ACCOUNT, YOUNG_ACCOUNT, CONNECT_PREDECESSOR]))
cases << run("a seller with no Gumroad-managed Stripe account", seed: seed(accounts: [GUMROAD_ACCOUNT]))
cases << run("a seller whose legal entity is outside the United States", seed: seed(infos: [INFO.merge(country: "Canada")]))
cases << run("a business whose country is outside the United States", seed: seed(infos: [INFO.merge(is_business: true, business_country: "Canada")]), http_responses: INSTANT)
cases << run("a seller with no compliance info", seed: seed(infos: []))
cases << run("a seller with no bank account", seed: seed(banks: []))
cases << run("a bank account with no Stripe external account", seed: seed(banks: [BANK.merge(stripe_bank_account_id: nil)]))
cases << run("a Stripe-held balance on the seller's account", seed: seed(balances: [balance_row(1)]), http_responses: INSTANT)
cases << run("a Gumroad-held balance", seed: seed(balances: [balance_row(1, merchant_account_id: 2)]), http_responses: INSTANT)
cases << run("a balance dated after today", seed: seed(balances: [balance_row(1, date: "2025-11-02")]), http_responses: INSTANT)
cases << run("a Stripe-held balance with no holding currency", seed: seed(balances: [balance_row(1, holding_currency: nil)]), http_responses: INSTANT)
cases << run("Stripe no longer knows the external account", seed: seed, http_responses: [refused("No such external account: 'ba_seller'", status: 404)])
cases << run("Stripe says the external account was deleted", seed: seed, http_responses: [refused("The external account has been deleted and can no longer be used.")])
cases << run("Stripe fails with a server error", seed: seed, http_responses: [refused("An error occurred on our side.", status: 500)] * 4)
cases << run("Stripe refuses the read for another reason", seed: seed, http_responses: [refused("Some other refusal.")])

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : c['supported']} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
