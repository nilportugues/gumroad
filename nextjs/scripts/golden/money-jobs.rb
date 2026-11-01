# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/money-jobs.golden.json: the real
# HandleStripeAutodebitForNegativeBalance and RecoverAusBacktaxFromStripeAccountJob (with the Credit,
# BalanceTransaction, Balance, BacktaxCollection and CurrencyHelper code they reach) against a
# scratch database, with Stripe and OpenExchangeRates answered by the local capture server. Each
# case runs as a Sidekiq job (support/sidekiq_executor.rb). Run it like lift-platform-stripe-pause.rb,
# with USE_DB_WORKER_REPLICAS=true.
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/money-jobs.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users merchant_accounts comments versions credits balance_transactions balances backtax_agreements backtax_collections
            payments].freeze

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0
Object.send(:remove_const, :CURRENCY_SOURCE)
CURRENCY_SOURCE = "http://127.0.0.1:#{SERVER.port}/api/latest.json?app_id=golden"
# The platform account the backtax transfer goes to.
STRIPE_PLATFORM = STRIPE_PLATFORM_ACCOUNT_ID

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def account_row(id, stripe_id, **overrides)
  {
    id:, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: stripe_id, json_data: nil, country: "US", currency: "usd",
    charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def balance_row(id, **overrides)
  {
    id:, user_id: 5, merchant_account_id: 1, date: "2025-10-01", amount_cents: 1000, holding_amount_cents: 1000, state: "unpaid",
    currency: "usd", holding_currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

ADMIN = user_row(GUMROAD_ADMIN_ID, email: "admin@example.com", username: "admin", external_id: "9999")
BASE_USERS = [user_row(5), ADMIN].freeze

def ok(body) = [200, { "Content-Type" => "application/json", "Request-Id" => "req_ok" }, body.is_a?(String) ? body : body.to_json]
def error_response(status, message) = [status, { "Content-Type" => "application/json", "Request-Id" => "req_err" },
                                       { error: { type: "invalid_request_error", message: } }.to_json]
def payout_json(amount:, status: "paid", transaction_status: "available", expanded: true)
  transaction = { id: "txn_1", object: "balance_transaction", status: transaction_status }
  { id: "po_1", object: "payout", amount:, status:, balance_transaction: expanded ? transaction : "txn_1" }
end

def run(name, args:, job: "HandleStripeAutodebitForNegativeBalance", seed: {}, stripe: [], redis: nil, &block)
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  setup = redis ? -> { r = Redis.new(url: REDIS_URL); redis.each { |k, v| r.set(k, v) }; r.close } : nil
  block ||= -> { job.constantize.new.perform(*args) }
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, args:, job:, setup:, &block)
  result.merge("stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "body").merge("stripe_account" => _1["headers"]["stripe-account"]) } })
end

cases = []

AUTODEBIT_ARGS = ["evt_1", "acct_1", "po_1"].freeze
def autodebit(name, seed:, amount: -1500, stripe: nil, **rest)
  stripe ||= [ok(payout_json(amount:)), ok(payout_json(amount:, expanded: false))]
  run(name, args: AUTODEBIT_ARGS, seed:, stripe:, **rest)
end

cases << autodebit("a negative payout becomes a credit and a new balance", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] })
cases << autodebit("the credit joins the oldest unpaid balance", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")],
  balances: [balance_row(1, state: "paid", date: "2025-09-01"), balance_row(2, date: "2025-10-05"), balance_row(3, date: "2025-10-01")],
})
cases << autodebit("a balance in another currency is not joined", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")], balances: [balance_row(1, holding_currency: "cad")],
})
cases << autodebit("a non-USD account converts the debit with the cached rate", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1", currency: "cad", country: "CA")],
}, redis: { "currencies:CAD" => "1.35" }, amount: -2700)
cases << autodebit("a non-USD account fetches a missing rate", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1", currency: "jpy", country: "JP")],
}, stripe: [ok(payout_json(amount: -15_000)), ok(payout_json(amount: -15_000, expanded: false)), ok({ rates: { JPY: 149.5 } })], amount: -15_000)
cases << autodebit("a seller on probation: the balance increase queues a refund eligibility update", seed: {
  users: [user_row(5, user_risk_state: "on_probation"), ADMIN], merchant_accounts: [account_row(1, "acct_1")],
})
cases << autodebit("a seller with refunds disabled: the balance increase queues a refund eligibility update", seed: {
  users: [user_row(5, flags: 1 << 7), ADMIN], merchant_accounts: [account_row(1, "acct_1")],
})
cases << autodebit("a Stripe Connect account holds its own funds", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1", json_data: '{"meta":{"stripe_connect":"true"}}')],
})
cases << autodebit("a debit of zero is ignored", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] }, amount: 0)
cases << autodebit("a positive payout is ignored", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] }, amount: 1500)
cases << autodebit("a failed debit needs nothing", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] },
                   stripe: [ok(payout_json(amount: -1500, status: "failed"))])
cases << autodebit("a payout still pending raises to retry", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] },
                   stripe: [ok(payout_json(amount: -1500, status: "pending", transaction_status: "pending"))])
cases << autodebit("a paid payout whose transaction is pending raises to retry", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] },
                   stripe: [ok(payout_json(amount: -1500, transaction_status: "pending"))])
cases << autodebit("a Stripe error propagates", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")] },
                   stripe: [error_response(404, "No such payout: 'po_1'")])
cases << autodebit("an unknown account", seed: { users: BASE_USERS }, )
cases << autodebit("a Gumroad-held account has no user to credit", seed: { users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1", user_id: nil)] })
cases << autodebit("a missing admin user", seed: { users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")] })
cases << autodebit("a credit comment for the user is stored", seed: {
  users: BASE_USERS, merchant_accounts: [account_row(1, "acct_1")],
  comments: [{ id: 1, commentable_id: 5, commentable_type: "User", comment_type: "note", author_name: "x", content: "earlier", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})

BACKTAX = "RecoverAusBacktaxFromStripeAccountJob"
def agreement_row(**overrides) = { id: 1, user_id: 5, jurisdiction: "AUSTRALIA", signature: "sig", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def credit_row(**overrides) = { id: 1, user_id: 5, amount_cents: -5000, merchant_account_id: 1, backtax_agreement_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def collection_row(id, cents) = { id:, user_id: 5, backtax_agreement_id: 1, amount_cents: cents, amount_cents_usd: cents, currency: "usd", stripe_transfer_id: "trr_#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }
def payment_row(id, transfer_id, **overrides) = { id:, user_id: 5, state: "completed", stripe_connect_account_id: "acct_1", stripe_internal_transfer_id: transfer_id, created_at: "2025-0#{id}-01 00:00:00", updated_at: SEEDED_AT }.merge(overrides)
def balance_json(available:, pending: 0, currency: "usd") = { object: "balance", available: [{ amount: available, currency: }], pending: [{ amount: pending, currency: }] }
def transfer_json(id, amount, currency: "usd", reversed: 0) = { id:, object: "transfer", amount:, amount_reversed: reversed, currency: }
def transfers_list(*transfers) = { object: "list", data: transfers, has_more: false, url: "/v1/transfers" }
def reversal_json(id) = { id:, object: "transfer_reversal" }

def backtax(name, seed: {}, stripe: [], redis: nil)
  run(name, args: [5], job: BACKTAX, seed:, stripe:, redis:)
end

BACKTAX_BASE = { users: BASE_USERS, backtax_agreements: [agreement_row], credits: [credit_row] }.freeze
def backtax_seed(accounts, **extra) = BACKTAX_BASE.merge(merchant_accounts: accounts).merge(extra)
US_ACCOUNT = account_row(1, "acct_1")
AU_ACCOUNT = account_row(1, "acct_1", currency: "aud", country: "AU")
AUD = { "currencies:AUD" => "1.5" }.freeze

cases << run("a missing creator", args: [404], job: BACKTAX)
cases << backtax("a creator without an agreement", seed: { users: BASE_USERS })
cases << backtax("an agreement already collected", seed: BACKTAX_BASE.merge(backtax_agreements: [agreement_row(flags: 1)]))
cases << backtax("an agreement without a credit", seed: { users: BASE_USERS, backtax_agreements: [agreement_row] })
cases << backtax("a credit of zero", seed: backtax_seed([US_ACCOUNT], credits: [credit_row(amount_cents: 0)]))
cases << backtax("collections already cover the amount", seed: backtax_seed([US_ACCOUNT], backtax_collections: [collection_row(1, 3000), collection_row(2, 2000)]))
cases << backtax("a Gumroad-held account records the collection without Stripe", seed: backtax_seed([account_row(1, "acct_1", user_id: nil)]))
cases << backtax("a Connect account holds its own funds", seed: backtax_seed([account_row(1, "acct_1", json_data: '{"meta":{"stripe_connect":"true"}}')]))
cases << backtax("an account without a Stripe id", seed: backtax_seed([account_row(1, "")]))
cases << backtax("a US account transfers the amount owed", seed: backtax_seed([US_ACCOUNT]),
                 stripe: [ok(balance_json(available: 4000, pending: 2000)), ok({ id: "tr_new", object: "transfer" })])
cases << backtax("a US account owes only what is left after partial collections", seed: backtax_seed([US_ACCOUNT], backtax_collections: [collection_row(1, 2000)]),
                 stripe: [ok(balance_json(available: 3500)), ok({ id: "tr_new", object: "transfer" })])
cases << backtax("a US account without enough balance is left alone", seed: backtax_seed([US_ACCOUNT]), stripe: [ok(balance_json(available: 3000, pending: 2000))])
cases << backtax("a Stripe error on the transfer collects nothing", seed: backtax_seed([US_ACCOUNT]),
                 stripe: [ok(balance_json(available: 9000)), error_response(400, "Insufficient funds in Stripe account.")])
cases << backtax("a balance without the account currency", seed: backtax_seed([US_ACCOUNT]), stripe: [ok(balance_json(available: 9000, currency: "eur"))])
cases << backtax("a non-US account reverses an internal transfer", seed: backtax_seed([AU_ACCOUNT], payments: [payment_row(1, "tr_1"), payment_row(2, "tr_2")]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")), ok(transfer_json("tr_1", 6000)), ok(reversal_json("trr_1"))])
cases << backtax("a non-US account combines internal transfers of one currency", seed: backtax_seed([AU_ACCOUNT], payments: [payment_row(1, "tr_1"), payment_row(2, "tr_2"), payment_row(3, nil), payment_row(4, "tr_4")]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")), ok(transfer_json("tr_1", 4000, currency: "aud")), error_response(404, "No such transfer"),
                          ok(transfer_json("tr_4", 9000, currency: "aud", reversed: 2000)), ok(reversal_json("trr_1")), ok(reversal_json("trr_4"))])
cases << backtax("a non-US account reverses old transfers from the list", seed: backtax_seed([AU_ACCOUNT]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")),
                          ok(transfers_list(transfer_json("tr_a", 5000, currency: "aud"), transfer_json("tr_b", 4000, currency: "aud"), transfer_json("tr_c", 4000, currency: "aud"))),
                          ok(reversal_json("trr_a")), ok(reversal_json("trr_b"))])
cases << backtax("a non-US account pages through the transfer list", seed: backtax_seed([AU_ACCOUNT]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")),
                          ok(transfers_list(transfer_json("tr_a", 2000, currency: "aud", reversed: 2000), transfer_json("tr_b", 1000), transfer_json("tr_x", 3000, currency: "eur"))),
                          ok(transfers_list(transfer_json("tr_c", 8000, currency: "aud"))), ok(reversal_json("trr_c"))])
cases << backtax("a non-US account whose transfers cannot cover the amount", seed: backtax_seed([AU_ACCOUNT]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")), ok(transfers_list(transfer_json("tr_a", 2000, currency: "aud"))), ok(transfers_list)])
cases << backtax("a non-US account without enough balance", seed: backtax_seed([AU_ACCOUNT]), redis: AUD,
                 stripe: [ok(balance_json(available: 5000, currency: "aud"))])
cases << backtax("a non-US account whose balance is inside the conversion buffer", seed: backtax_seed([AU_ACCOUNT]), redis: AUD,
                 stripe: [ok(balance_json(available: 7800, currency: "aud"))])
cases << backtax("a non-US account that settles in usd", seed: backtax_seed([account_row(1, "acct_1", country: "CA")], payments: [payment_row(1, "tr_1")]),
                 stripe: [ok(balance_json(available: 100_000)), ok(transfer_json("tr_1", 7000)), ok(reversal_json("trr_1"))])
cases << backtax("a Stripe error on a reversal keeps the earlier ones", seed: backtax_seed([AU_ACCOUNT], payments: [payment_row(1, "tr_1"), payment_row(2, "tr_2")]), redis: AUD,
                 stripe: [ok(balance_json(available: 100_000, currency: "aud")), ok(transfer_json("tr_1", 4000, currency: "aud")), ok(transfer_json("tr_2", 4000, currency: "aud")),
                          ok(reversal_json("trr_1")), error_response(400, "Transfer already reversed")])

File.write(OUT, JSON.pretty_generate({ "now" => Time.utc(2025, 11, 1, 12, 30, 45, 123_000).to_f, "admin_id" => GUMROAD_ADMIN_ID, "platform_account_id" => STRIPE_PLATFORM, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
