# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payout-users-service.golden.json: PayoutUsersWorker (the weekly and the daily payout of one
# seller, through PayoutUsersService) and ProcessPaymentWorker for a Stripe payment, run by the real classes against a scratch database.
# Stripe is never reached: WebMock answers each request in order from the case's `http_responses`, and `http` lists what Rails sent with
# the number of statements before each request.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payout-users-service.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payout-users-service.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
PAYOUT_DATE = "2025-10-31"
TABLES = %w[users comments versions payments payments_balances balances bank_accounts merchant_accounts credits
            balance_transactions user_compliance_info seller_profiles links].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

# `sleep(2)` between the destination charge lookups: recorded, not slept.
SLEEPS = []
StripePayoutProcessor.singleton_class.prepend(Module.new { define_method(:sleep) { |seconds| SLEEPS << seconds } })

# What ErrorNotifier was told, so a rescued error is part of the golden.
NOTIFIED = []
ErrorNotifier.singleton_class.prepend(Module.new do
  define_method(:notify) do |error, **context|
    NOTIFIED << { "error" => error.is_a?(Exception) ? "#{error.class.name}: #{error.message}" : error.to_s, "context" => context.transform_keys(&:to_s) }
  end
end)

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

def seed(balances:, users: [user_row(5), user_row(767_082, email: "admin@example.com", username: "admin")], payments: [payment_row(1)], info: [INFO], links: [])
  { users:, payments:, balances:, bank_accounts: [BANK], merchant_accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT], user_compliance_info: info }
end

def ok(body) = { status: 200, body: body.to_json, headers: JSON_HEADERS }
def refused(message, status: 400, code: nil) = { status:, body: { error: { message:, code:, type: "invalid_request_error" }.compact }.to_json, headers: JSON_HEADERS }
DROPPED = { dropped: true }.freeze

def instant_available(amount) = ok(object: "balance", available: [], pending: [], instant_available: [{ amount:, currency: "usd", net_available: [{ amount:, destination: "ba_seller", source_types: {} }] }])
def stripe_balance(available:, pending: 0) = ok(object: "balance", available: [{ amount: available, currency: "usd" }], pending: [{ amount: pending, currency: "usd" }])
def payout(amount, **overrides) = ok({ id: "po_one", object: "payout", amount:, arrival_date: 1_762_300_000, currency: "usd", application_fee_amount: 0 }.merge(overrides))
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

RESULT = {}

def run(name, seed:, http_responses: [], &block)
  SLEEPS.clear
  NOTIFIED.clear
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, &block)
  result.merge("call" => CALL.dup, "sleeps" => SLEEPS.dup, "notified" => NOTIFIED.dup,
               "payments" => Payment.order(:id).map { |p| p.attributes.slice("id", "state", "failure_reason", "stripe_transfer_id", "stripe_internal_transfer_id", "amount_cents") })
end

CALL = {}

def payout_users(*args)
  CALL.replace("job" => "PayoutUsersWorker", "args" => args)
  PayoutUsersWorker.new.perform(*args)
end

def pay(payment_id)
  CALL.replace("job" => "ProcessPaymentWorker", "args" => [payment_id])
  ProcessPaymentWorker.new.perform(payment_id)
end

ONE = [balance_row(1)].freeze
TWO = [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: 7000, holding_amount_cents: 7000, created_at: "2025-10-26 01:00:00")].freeze
GUMROAD_HELD = balance_row(3, merchant_account_id: 2, date: "2025-10-27", holding_amount_cents: 20_000, amount_cents: 20_000, created_at: "2025-10-27 01:00:00")

cases = []

# The weekly payout: the drift read of the destination balance and the payout request follow the claim.
cases << run("a weekly payout for one Stripe-held balance", seed: seed(balances: ONE),
             http_responses: [stripe_balance(available: 22_000), payout(15_000)]) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("a weekly payout for two Stripe-held balances", seed: seed(balances: TWO),
             http_responses: [stripe_balance(available: 22_000), payout(22_000)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "standard") }
cases << run("a weekly payout for balances held by Stripe and Gumroad", seed: seed(balances: ONE + [GUMROAD_HELD]),
             http_responses: [stripe_balance(available: 22_000), internal_transfer(20_000), destination_charge(20_000), payout(35_000)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "standard", false) }
cases << run("a weekly payout for a balance held by Gumroad alone", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer(20_000), destination_charge(20_000), payout(20_000)]) { payout_users(PAYOUT_DATE, "STRIPE", [5]) }
cases << run("a weekly payout for a seller with no compliance info", seed: seed(balances: ONE, info: []),
             http_responses: [stripe_balance(available: 22_000), payout(15_000)]) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("no balance dated by the payout date", seed: seed(balances: [balance_row(1, date: "2025-11-01")])) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("a seller with no unpaid balance", seed: seed(balances: [balance_row(1, state: "paid")])) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("a paused seller", seed: seed(balances: ONE, users: [user_row(5, flags: 1 << 19, json_data: '{"payouts_paused_by":"admin"}'), user_row(767_082, email: "admin@example.com", username: "admin")])) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("a negative ledger is withheld", seed: seed(balances: ONE + [balance_row(2, date: "2025-10-26", amount_cents: -20_000, holding_amount_cents: -20_000, created_at: "2025-10-26 01:00:00")])) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("a seller that does not exist", seed: seed(balances: ONE)) { payout_users(PAYOUT_DATE, "STRIPE", 99) }
cases << run("nobody to pay", seed: seed(balances: ONE)) { payout_users(PAYOUT_DATE, "STRIPE", nil) }
cases << run("an empty list of sellers", seed: seed(balances: ONE)) { payout_users(PAYOUT_DATE, "STRIPE", []) }

# The destination balance cannot cover the ledger: the payout fails as insufficient funds and nothing is requested at Stripe.
cases << run("a destination balance short of the ledger", seed: seed(balances: ONE),
             http_responses: [stripe_balance(available: 5000)]) { payout_users(PAYOUT_DATE, "STRIPE", 5) }

{
  "an account without the funds" => [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")],
  "an account that cannot be paid" => [refused("Cannot create payouts; your account has outstanding requirements.")],
  "a bank account Stripe cannot find" => [refused("No such external account: 'ba_seller'", status: 404)],
  "a rate limit" => [{ status: 429, body: { error: { message: "Too many requests", type: "rate_limit_error" } }.to_json, headers: JSON_HEADERS }],
  "an error no reason covers" => [refused("Something unexpected")],
  "a server error" => [refused("Server trouble", status: 500)] * 4,
  "a dropped connection" => [DROPPED] * 4,
}.each do |label, answers|
  cases << run("Stripe answers the weekly payout with #{label}", seed: seed(balances: ONE),
               http_responses: [stripe_balance(available: 22_000)] + answers) do
    payout_users(PAYOUT_DATE, "STRIPE", 5)
  end
end

cases << run("the weekly payout fails after the internal transfer and the transfer is reversed", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer(20_000), destination_charge(20_000),
                              refused("Cannot create payouts; your account has outstanding requirements.")] + reversal_answers(20_000)) { payout_users(PAYOUT_DATE, "STRIPE", 5) }
cases << run("Stripe refuses the internal transfer of a weekly payout", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")]) { payout_users(PAYOUT_DATE, "STRIPE", 5) }

# The daily payout: the period ends on the last instantly payable balance.
cases << run("a daily payout for one Stripe-held balance", seed: seed(balances: ONE),
             http_responses: [instant_available(1_000_000_00), stripe_balance(available: 1_000_000_00), payout(14_563, application_fee_amount: 437)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "instant") }
cases << run("a daily payout ends on the last instantly payable balance", seed: seed(balances: TWO + [balance_row(4, date: "2025-10-30", created_at: "2025-10-30 01:00:00")]),
             http_responses: [instant_available(15_000), stripe_balance(available: 1_000_000_00), payout(21_359, application_fee_amount: 641)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "instant") }
cases << run("a daily payout for a balance held by Gumroad alone", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [instant_available(0), internal_transfer(20_000), destination_charge(20_000), payout(19_417, application_fee_amount: 583)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "instant") }
cases << run("a daily payout with nothing Stripe can cover instantly", seed: seed(balances: ONE),
             http_responses: [instant_available(0)]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "instant") }
cases << run("a daily payout the instant fee is refused for", seed: seed(balances: ONE),
             http_responses: [instant_available(1_000_000_00), stripe_balance(available: 1_000_000_00), refused("Cannot create payouts; your account has outstanding requirements.")]) { payout_users(PAYOUT_DATE, "STRIPE", 5, "instant") }

# ProcessPaymentWorker: the payment is already prepared, with its balances.
def processing(id = 7, **overrides) = payment_row(id, state: "processing", amount_cents: 15_000, payout_period_end_date: PAYOUT_DATE, created_at: "2025-10-31 10:00:00", **overrides)

def payment_seed(payment: processing, balances: [balance_row(1, state: "processing")])
  seed(balances:, payments: [payment]).merge(payments_balances: balances.map { { payment_id: payment[:id], balance_id: _1[:id] } })
end

cases << run("a processing payment is paid out", seed: payment_seed, http_responses: [payout(15_000)]) { pay(7) }
cases << run("a processing instant payment records the fee", seed: payment_seed(payment: processing(json_data: { payout_type: "instant" }.to_json)),
             http_responses: [payout(14_563, application_fee_amount: 437)]) { pay(7) }
cases << run("a payment that is not processing is left alone", seed: payment_seed(payment: processing(state: "completed"))) { pay(7) }
cases << run("a payment that does not exist", seed: payment_seed) { pay(99) }
{
  "an account without the funds" => [refused("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient")],
  "a bank account Stripe cannot find" => [refused("No such external account: 'ba_seller'", status: 404)],
  "a rate limit" => [{ status: 429, body: { error: { message: "Too many requests", type: "rate_limit_error" } }.to_json, headers: JSON_HEADERS }],
  "a dropped connection" => [DROPPED] * 4,
}.each do |label, answers|
  cases << run("Stripe answers the payment's payout with #{label}", seed: payment_seed, http_responses: answers) do
    pay(7)
  end
end
cases << run("a processing payment whose payout fails after an internal transfer reverses it",
             seed: payment_seed(payment: processing(stripe_internal_transfer_id: "tr_internal", amount_cents: 20_000), balances: [balance_row(3, merchant_account_id: 2, holding_amount_cents: 20_000, amount_cents: 20_000, state: "processing")]),
             http_responses: [refused("Cannot create payouts; your account has outstanding requirements.")] + reversal_answers(20_000)) { pay(7) }

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases: }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : 'ok'} #{c['payments'].map { _1.slice('state', 'failure_reason').values.join('/') }.inspect} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
