# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/payouts-prepare.golden.json: StripePayoutProcessor.prepare_payment_and_set_amount
# (the destination checks, the balance drift guard, the internal transfer of Gumroad-held money with its destination charge lookup,
# the amount in the payout currency net of the instant fee, and the failure branches with the reversal or hold they trigger) and
# stripe_invalid_request_error_failure_reason, run by the real models against a scratch database. Stripe is never reached: WebMock
# answers each request in order from the case's `http_responses`; `http` lists what Rails sent with the number of statements before it.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_23 TEST_DATABASE_NAME=gumroad_test_23 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/41 SIDEKIQ_REDIS_HOST=redis:6379/42 RPUSH_REDIS_HOST=redis:6379/43 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/44 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/payouts-prepare.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/payouts-prepare.golden.json")
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
  { id:, user_id: 5, state: "creating", processor: "STRIPE", amount_cents: 0, payout_period_end_date: "2025-10-31", currency: "usd",
    stripe_connect_account_id: "acct_seller", bank_account_id: 11, flags: 0, json_data: nil, created_at: "2025-11-01 12:30:45", updated_at: SEEDED_AT }.merge(overrides)
end

BANK = { id: 11, user_id: 5, account_number: "x", account_number_last_four: "6789", account_holder_full_name: "Seller", created_at: SEEDED_AT, updated_at: SEEDED_AT }.freeze
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

RESULT = {}

def run(name, seed:, http_responses: [], payout_currency: nil, account: :stripe, **extra)
  SLEEPS.clear
  RESULT.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, http_responses:, http_timeline: true, **extra) do
    payment = Payment.find(7)
    balances = payment.balances.order(:id).to_a
    # Payouts.create_payments hands the group's balances over as the payment's own association target.
    payment.association(:balances).target = balances
    merchant_account = account == :none ? nil : MerchantAccount.find(3)
    RESULT[:payment] = payment
    begin
      RESULT[:value] = StripePayoutProcessor.prepare_payment_and_set_amount(payment, balances, merchant_account, payout_currency)
    ensure
      RESULT[:attributes] = payment.attributes.slice("state", "amount_cents", "currency", "stripe_connect_account_id", "stripe_internal_transfer_id", "failure_reason", "bank_account_id")
                                   .merge("error_message" => payment.error_message, "retired_account_drain" => payment.retired_account_drain, "errors" => payment.errors.full_messages)
    end
  end
  result.merge("returned" => RESULT[:value], "payment" => RESULT[:attributes], "sleeps" => SLEEPS.dup, "payout_currency" => payout_currency, "account" => account.to_s)
end

cases = []
STRIPE_HELD = [balance_row(1), balance_row(2, date: "2025-10-26", amount_cents: 7000, holding_amount_cents: 7000)].freeze
GUMROAD_HELD = balance_row(3, merchant_account_id: 2, date: "2025-10-27", amount_cents: 100_000, holding_amount_cents: 100_000)

cases << run("Stripe-held balances sum to the payout amount after the drift check", seed: seed(balances: STRIPE_HELD),
             http_responses: [stripe_balance(available: 22_000)])

cases << run("an instant payout is net of the instant fee", seed: seed(balances: STRIPE_HELD, payment: payment_row(7, json_data: { payout_type: "instant" }.to_json)),
             http_responses: [stripe_balance(available: 22_000)])

cases << run("pending funds count toward the destination balance", seed: seed(balances: STRIPE_HELD),
             http_responses: [stripe_balance(available: 10_000, pending: 12_000)])

cases << run("a destination balance short of the ledger fails the payout as insufficient funds", seed: seed(balances: STRIPE_HELD),
             http_responses: [stripe_balance(available: 5000, pending: 0)])

cases << run("a retired account still holding funds is named in the drift error", seed: seed(balances: STRIPE_HELD, accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT, RETIRED_ACCOUNT]),
             http_responses: [stripe_balance(available: 5000), stripe_balance(available: 3000, pending: 1000)])

cases << run("a retired account Stripe cannot read adds no hint", seed: seed(balances: STRIPE_HELD, accounts: [GUMROAD_ACCOUNT, STRIPE_ACCOUNT, RETIRED_ACCOUNT]),
             http_responses: [stripe_balance(available: 5000), refused("No such account", status: 404)])

cases << run("a ledger that nets negative against a positive USD ledger fails before Stripe is asked",
             seed: seed(balances: [balance_row(1, amount_cents: 5000, holding_amount_cents: -2500), balance_row(2, amount_cents: 5000, holding_amount_cents: 0)]))

cases << run("a rate limit on the destination balance fails the payout as rate limited", seed: seed(balances: STRIPE_HELD),
             http_responses: [rate_limited])

cases << run("an unreachable destination balance fails the payout as processor unavailable and raises", seed: seed(balances: STRIPE_HELD),
             http_responses: [DROPPED, DROPPED, DROPPED, DROPPED])

cases << run("a destination left out is read from the seller's own account", seed: seed(balances: STRIPE_HELD), account: :none,
             http_responses: [stripe_balance(available: 22_000)])

cases << run("a seller with no Stripe account of their own is failed", seed: seed(balances: [GUMROAD_HELD], accounts: [GUMROAD_ACCOUNT]), account: :none)

cases << run("Gumroad-held money is transferred to the seller's account", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer, destination_charge])

cases << run("Stripe-held and Gumroad-held money are paid together", seed: seed(balances: STRIPE_HELD + [GUMROAD_HELD], payment: payment_row(7, json_data: { payout_type: "instant" }.to_json)),
             http_responses: [stripe_balance(available: 22_000), internal_transfer, destination_charge])

cases << run("the destination charge is looked up again until its balance transaction is ready", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer, destination_charge(ready: false), destination_charge(ready: false), destination_charge])

cases << run("a destination charge that never gets a balance transaction fails the payout and reverses the transfer", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer, destination_charge(ready: false), destination_charge(ready: false), destination_charge(ready: false)] + reversal_answers)

cases << run("an internal transfer Stripe refuses fails the payout with the reason its message names", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [refused("Cannot create live transfers; your account has outstanding requirements.")])

cases << run("an internal transfer Stripe refuses without a known reason fails the payout with none", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [refused("Something unexpected")])

cases << run("an internal transfer whose connection drops is an unknown outcome and holds the seller", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [DROPPED, DROPPED, DROPPED, DROPPED])

cases << run("a destination charge lookup that drops after the transfer reverses it", seed: seed(balances: [GUMROAD_HELD]),
             http_responses: [internal_transfer, DROPPED, DROPPED, DROPPED, DROPPED] + reversal_answers)

cases << run("Gumroad-held money in another currency fails the payout as a currency mismatch",
             seed: seed(balances: [balance_row(3, merchant_account_id: 2, currency: "usd", holding_currency: "eur")]))

HUF_ACCOUNT = STRIPE_ACCOUNT.merge(currency: "huf")
cases << run("a payout in forints discards the part below a hundred", seed: seed(balances: [balance_row(1, holding_currency: "huf", holding_amount_cents: 12_345)], accounts: [GUMROAD_ACCOUNT, HUF_ACCOUNT]),
             http_responses: [stripe_balance(available: 50_000, currency: "huf")], payout_currency: "huf")

KRW_ACCOUNT = STRIPE_ACCOUNT.merge(currency: "krw")
cases << run("a payout in won is multiplied by a hundred and skips the drift check", seed: seed(balances: [balance_row(1, holding_currency: "krw", holding_amount_cents: 12_345)], accounts: [GUMROAD_ACCOUNT, KRW_ACCOUNT]),
             payout_currency: "krw")

# stripe_invalid_request_error_failure_reason, for the messages the processor knows and a few it does not.
reasons = [
  ["You have insufficient funds in your Stripe account", "balance_insufficient"],
  ["Cannot create live transfers", nil],
  ["Cannot create payouts; outstanding", nil],
  ["Your account needs to have at least one of the following capabilities enabled: transfers", nil],
  ["Debit card transfers are only supported for amounts less than $3,000.00", nil],
  ["There are insufficient funds in your Stripe account", nil],
  ["There are insufficient funds in Stripe account", nil],
  ["The bank account has been deleted and can no longer be used", nil],
  ["No such external account: 'ba_x'", nil],
  ["Attempting to create a transfer of eur to a destination that supports usd, with a suggestion", nil],
  ["Amount must be no less than $1.00", nil],
  ["Your account requires further intervention", nil],
  ["Something else", nil],
  ["", nil],
].map do |message, code|
  error = Stripe::InvalidRequestError.new(message, nil, http_status: 400, json_body: { error: { message:, code: }.compact })
  [message, code, StripePayoutProcessor.send(:stripe_invalid_request_error_failure_reason, error)]
end

File.write(OUT, JSON.pretty_generate({ now: NOW.to_f, cases:, failure_reasons: reasons }) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
cases.each { |c| puts "#{c['name']}: #{c['error'] ? c['error'].inspect : 'ok'} -> #{c['returned'].inspect} #{c['payment']&.slice('state', 'amount_cents', 'failure_reason').inspect} (#{c['statements'].size} statements, #{c['http'].size} requests)" }
