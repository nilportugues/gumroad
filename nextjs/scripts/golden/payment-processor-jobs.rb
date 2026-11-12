# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/payment-processor-jobs.golden.json: the payout, abandoned
# purchase, balance and Stripe event jobs of WS-66, run by the real app against a scratch database, each
# case as a Sidekiq job (support/sidekiq_executor.rb). Run it like refund-dispute-jobs.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws66 TEST_DATABASE_NAME=gumroad_ws66 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/3 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/3 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/3 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/3 \
#     bundle exec rails runner nextjs/scripts/golden/payment-processor-jobs.rb
#
# Jobs Node hands back to Rails are recorded up to the call that would reach a payment processor or write,
# which a marker exception stands in for: the statements recorded are the ones Node must send first.
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/payment-processor-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases payments scheduled_payouts balances large_sellers merchant_accounts].freeze

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ScheduledPayout.prepend(Module.new do
  def execute!
    raise HandBackMarker
  end
end)
Payment.prepend(Module.new do
  def sync_with_payout_processor
    raise HandBackMarker
  end

  def was_created_in_split_mode?
    raise HandBackMarker
  end
end)
FailAbandonedPurchaseWorker.prepend(Module.new do
  private
    def with_stripe_error_handler
      raise HandBackMarker
    end
end)
AdminMailer.singleton_class.prepend(Module.new do
  def low_balance_notify(*)
    raise HandBackMarker
  end
end)
StripePayoutProcessor.singleton_class.prepend(Module.new do
  def handle_stripe_event_payout_reversed(*)
    raise HandBackMarker
  end
end)
StripeEventHandler.prepend(Module.new do
  private
    def handle_event_for_gumroad = raise(HandBackMarker)
    def handle_event_for_connected_account(**) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "in_progress", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, state, processor, **overrides)
  { id:, user_id: 1, state:, processor:, amount_cents: 500, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def scheduled_payout_row(id, **overrides)
  { id:, user_id: 1, action: "payout", delay_days: 21, scheduled_at: "2026-11-01 00:00:00", status: "pending", payout_amount_cents: 500,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def balance_row(id, user_id, state, amount_cents, **overrides)
  { id:, user_id:, date: "2026-10-01", amount_cents:, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def large_seller_row(id, user_id, sales_count)
  { id:, user_id:, sales_count:, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def run(name, job, args, seed: {}, hands_back: false, setup: nil, stripe: [], **extra)
  handed_back = false
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job:, args:, **extra) do
    job.constantize.new.perform(*args)
  rescue HandBackMarker
    handed_back = true
  end
  abort "#{name}: hands_back is #{hands_back} but the job #{handed_back ? 'reached' : 'never reached'} the hand-back marker" if handed_back != hands_back
  result.delete("rows")
  result.merge("hands_back" => hands_back, "stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "body") } })
end

cases = []

# --- ExecuteScheduledPayoutsJob -----------------------------------------------------------------
def scheduled(name, rows, **options) = run(name, "ExecuteScheduledPayoutsJob", [], seed: { scheduled_payouts: rows }, **options)

cases << scheduled("scheduled: nothing scheduled", [])
cases << scheduled("scheduled: only payouts that are not pending or not yet due",
                   [scheduled_payout_row(1, scheduled_at: "2026-11-05 00:00:00"), scheduled_payout_row(2, status: "executed"),
                    scheduled_payout_row(3, status: "cancelled"), scheduled_payout_row(4, scheduled_at: "2026-11-04 12:30:46")])
cases << scheduled("scheduled: a due payout is handed back before it is executed", [scheduled_payout_row(1, scheduled_at: "2026-11-04 12:30:45")], hands_back: true)
cases << scheduled("scheduled: a due payout behind ones that are not due", [scheduled_payout_row(1, status: "held"), scheduled_payout_row(2), scheduled_payout_row(3)], hands_back: true)

# --- SyncStuckPayoutsJob ------------------------------------------------------------------------
def stuck(name, processor, rows, **options) = run(name, "SyncStuckPayoutsJob", [processor], seed: { payments: rows }, **options)

cases << stuck("stuck: stripe, no payments", "STRIPE", [])
cases << stuck("stuck: paypal, no payments", "PAYPAL", [])
cases << stuck("stuck: stripe payments that are not stuck yet", "STRIPE",
               [payment_row(1, "creating", "STRIPE", created_at: "2026-11-04 00:00:00"),
                payment_row(2, "processing", "STRIPE", created_at: "2026-11-03 00:00:00"),
                payment_row(3, "processing", "STRIPE", created_at: "2026-11-01 00:00:00", json_data: { arrival_date: Time.utc(2026, 11, 4, 12).to_i + 86_400 }.to_json),
                payment_row(4, "unclaimed", "STRIPE", created_at: "2026-10-01 00:00:00"),
                payment_row(5, "completed", "STRIPE", created_at: "2026-10-01 00:00:00"),
                payment_row(6, "creating", "PAYPAL", created_at: "2026-10-01 00:00:00")])
cases << stuck("stuck: a stripe payment creating for over a day", "STRIPE", [payment_row(1, "creating", "STRIPE", created_at: "2026-11-03 12:30:44")], hands_back: true)
cases << stuck("stuck: a stripe payment processing past its arrival date", "STRIPE",
               [payment_row(1, "processing", "STRIPE", created_at: "2026-11-03 00:00:00", json_data: { arrival_date: Time.utc(2026, 11, 3).to_i }.to_json)], hands_back: true)
cases << stuck("stuck: a stripe payment processing for over three days without an arrival date", "STRIPE",
               [payment_row(1, "processing", "STRIPE", created_at: "2026-11-01 12:30:44")], hands_back: true)
cases << stuck("stuck: paypal payments in any stuck state", "PAYPAL", [payment_row(1, "unclaimed", "PAYPAL")], hands_back: true)
cases << stuck("stuck: paypal payments that are done", "PAYPAL", [payment_row(1, "completed", "PAYPAL"), payment_row(2, "failed", "PAYPAL"), payment_row(3, "processing", "STRIPE")])
cases << stuck("stuck: an unknown processor uses the paypal states", "SQUARE", [payment_row(1, "creating", "SQUARE")], hands_back: true)

# --- UpdatePayoutStatusWorker -------------------------------------------------------------------
def payout_status(name, rows, args: [1], **options) = run(name, "UpdatePayoutStatusWorker", args, seed: { payments: rows }, **options)

cases << payout_status("payout status: no such payment", [])
cases << payout_status("payout status: a payment that is not processing is left alone", [payment_row(1, "completed", "PAYPAL")])
cases << payout_status("payout status: a payment still creating is left alone", [payment_row(1, "creating", "PAYPAL")])
cases << payout_status("payout status: a processing payment is handed back", [payment_row(1, "processing", "PAYPAL")], hands_back: true)
cases << payout_status("payout status: the payment id arrives as a string", [payment_row(1, "processing", "PAYPAL")], args: ["1"], hands_back: true)

# --- FailAbandonedPurchaseWorker ----------------------------------------------------------------
def abandoned(name, rows, args: [1], **options) = run(name, "FailAbandonedPurchaseWorker", args, seed: { purchases: rows }, **options)

cases << abandoned("abandoned: no such purchase", [])
cases << abandoned("abandoned: a purchase that is not in progress is left alone", [purchase_row(1, purchase_state: "successful")])
cases << abandoned("abandoned: a purchase that failed already", [purchase_row(1, purchase_state: "failed", created_at: "2026-11-04 00:00:00")])
cases << abandoned("abandoned: too early, reschedules for fifteen minutes after creation", [purchase_row(1, created_at: "2026-11-04 12:20:00")])
cases << abandoned("abandoned: one second early", [purchase_row(1, created_at: "2026-11-04 12:15:46")])
cases << abandoned("abandoned: exactly fifteen minutes old is handed back", [purchase_row(1, created_at: "2026-11-04 12:15:45")], hands_back: true)
cases << abandoned("abandoned: an old purchase is handed back", [purchase_row(1, created_at: "2026-11-03 00:00:00")], hands_back: true)
cases << abandoned("abandoned: the purchase id arrives as a string", [purchase_row(1, created_at: "2026-11-04 12:20:00")], args: ["1"])

# --- LowBalanceFraudCheckWorker -----------------------------------------------------------------
def low_balance(name, balances, purchases: [purchase_row(1, purchase_state: "successful")], users: [user_row(1)], args: [1], **options)
  run(name, "LowBalanceFraudCheckWorker", args, seed: { users:, purchases:, balances: }, **options)
end

cases << low_balance("low balance: no such purchase", [], purchases: [])
cases << low_balance("low balance: a purchase without a seller fails", [], purchases: [purchase_row(1, seller_id: nil)])
cases << low_balance("low balance: a seller that is gone fails", [], users: [])
cases << low_balance("low balance: no balances", [])
cases << low_balance("low balance: a balance above the threshold", [balance_row(1, 1, "unpaid", -9_999)])
cases << low_balance("low balance: only unpaid balances count", [balance_row(1, 1, "unpaid", -9_000), balance_row(2, 1, "paid", -50_000), balance_row(3, 2, "unpaid", -50_000)])
cases << low_balance("low balance: exactly the threshold is handed back", [balance_row(1, 1, "unpaid", -10_000)], hands_back: true)
cases << low_balance("low balance: below the threshold is handed back", [balance_row(1, 1, "unpaid", -20_000), balance_row(2, 1, "unpaid", 500)], hands_back: true)
cases << low_balance("low balance: the purchase id arrives as a string", [balance_row(1, 1, "unpaid", -20_000)], args: ["1"], hands_back: true)

# --- HandleStripeEventWorker --------------------------------------------------------------------
def stripe_event(name, params, **options) = run(name, "HandleStripeEventWorker", [params], **options)

cases << stripe_event("stripe event: an unhandled event type is ignored", { "id" => "evt_1", "type" => "invoice.paid" })
cases << stripe_event("stripe event: a prefix of a handled type is not handled", { "type" => "charge" })
cases << stripe_event("stripe event: no type", { "id" => "evt_1" })
cases << stripe_event("stripe event: a null type", { "type" => nil })
cases << stripe_event("stripe event: an unhandled event for a connected account", { "type" => "customer.created", "account" => "acct_1" })
cases << stripe_event("stripe event: a charge event is handed back", { "type" => "charge.succeeded", "data" => { "object" => { "id" => "ch_1" } } }, hands_back: true)
cases << stripe_event("stripe event: a refund event is handed back", { "type" => "refund.updated" }, hands_back: true)
cases << stripe_event("stripe event: a payout event for a connected account is handed back", { "type" => "payout.paid", "account" => "acct_1" }, hands_back: true)
cases << stripe_event("stripe event: a deauthorization of an account nobody has", { "type" => "account.application.deauthorized", "account" => "acct_1" })
cases << stripe_event("stripe event: a subscription event is handed back", { "type" => "customer.subscription.updated" }, hands_back: true)
cases << stripe_event("stripe event: a checkout session is handed back", { "type" => "checkout.session.completed" }, hands_back: true)
cases << stripe_event("stripe event: a payment intent that is not handled", { "type" => "payment_intent.created" })
cases << stripe_event("stripe event: a payment intent that succeeded is handed back", { "type" => "payment_intent.succeeded" }, hands_back: true)

# --- LargeSellersUpdateUserBalanceStatsCacheWorker ----------------------------------------------
THRESHOLD_KEY = "balance_stats:sales_caching_threshold"
EXCLUDED_KEY = "balance_stats:users_excluded_from_caching"

def with_batch_size(size)
  klass = LargeSellersUpdateUserBalanceStatsCacheWorker
  klass.send(:remove_const, :PUSH_BULK_BATCH_SIZE)
  klass.const_set(:PUSH_BULK_BATCH_SIZE, size)
  yield
ensure
  klass.send(:remove_const, :PUSH_BULK_BATCH_SIZE)
  klass.const_set(:PUSH_BULK_BATCH_SIZE, 1_000)
end

def large_sellers(name, sales_counts, threshold: nil, excluded: [], batch_size: 1_000, without_users: [])
  users = sales_counts.each_index.map { user_row(_1 + 1) }.reject { without_users.include?(_1[:id]) }
  sellers = sales_counts.each_with_index.map { |count, i| large_seller_row(i + 1, i + 1, count) }
  setup = -> do
    redis.set(THRESHOLD_KEY, threshold) if threshold
    excluded.each { redis.sadd(EXCLUDED_KEY, _1) }
  end
  with_batch_size(batch_size) do
    run(name, "LargeSellersUpdateUserBalanceStatsCacheWorker", [], seed: { users:, large_sellers: sellers }, setup:, batch_size:)
  end
end

cases << large_sellers("balance stats: no large sellers", [])
cases << large_sellers("balance stats: sellers under the default threshold are skipped", [49_999, 10])
cases << large_sellers("balance stats: sellers at the default threshold are queued", [50_000, 49_999, 90_000])
cases << large_sellers("balance stats: a configured threshold", [100, 99, 250], threshold: "100")
cases << large_sellers("balance stats: a threshold that is not a number reads as zero", [0, 5], threshold: "abc")
cases << large_sellers("balance stats: a threshold with trailing text", [12, 11], threshold: "12 sales")
cases << large_sellers("balance stats: a threshold beyond 2**53 matches nobody", [60_000, 70_000], threshold: "9007199254740993")
cases << large_sellers("balance stats: a threshold of 20 digits keeps every digit", [60_000], threshold: "  123_456789012345678901 sales")
cases << large_sellers("balance stats: a negative threshold beyond 2**53 matches everybody", [0, 5], threshold: "-9007199254740993")
cases << large_sellers("balance stats: users excluded from caching", [60_000, 70_000, 80_000], excluded: [2, 3])
cases << large_sellers("balance stats: an exclusion for a user who is not a large seller", [60_000], excluded: [9])
cases << large_sellers("balance stats: every large seller excluded", [60_000, 70_000], excluded: [1, 2])
cases << large_sellers("balance stats: batches of two are staggered across the window", [60_000, 61_000, 62_000, 63_000, 64_000], batch_size: 2)
cases << large_sellers("balance stats: a batch exactly filled", [60_000, 61_000], batch_size: 2)
cases << large_sellers("balance stats: a large seller whose user is gone is not queued", [60_000, 61_000], without_users: [2])

# --- HandlePayoutReversedWorker -----------------------------------------------------------------
def ok(body) = [200, { "Content-Type" => "application/json", "Request-Id" => "req_ok" }, body.to_json]

# :absent leaves the key out; nil sends an explicit null.
def payout_json(status, balance_transaction)
  { id: "po_rev", object: "payout", status:, balance_transaction: }.reject { |_, v| v == :absent }
end

def reversal(name, response, args: [7, "po_rev", "acct_1"], payments: [payment_row(7, "completed", "STRIPE")], **options)
  run(name, "HandlePayoutReversedWorker", args, seed: { payments: }, stripe: [response], **options)
end

TXN_AVAILABLE = { id: "txn_1", object: "balance_transaction", status: "available" }.freeze
TXN_PENDING = { id: "txn_1", object: "balance_transaction", status: "pending" }.freeze

cases << reversal("reversed: a paid payout whose balance transaction is available is handed back", ok(payout_json("paid", TXN_AVAILABLE)), hands_back: true)
cases << reversal("reversed: the payment id arrives as a string", ok(payout_json("paid", TXN_AVAILABLE)), args: ["7", "po_rev", "acct_1"], hands_back: true)
cases << reversal("reversed: the payment is gone when the payout is recorded", ok(payout_json("paid", TXN_AVAILABLE)), payments: [])
cases << reversal("reversed: a paid payout still settling times out", ok(payout_json("paid", TXN_PENDING)))
cases << reversal("reversed: a pending payout times out", ok(payout_json("pending", TXN_PENDING)))
cases << reversal("reversed: an in transit payout with an available balance transaction times out", ok(payout_json("in_transit", TXN_AVAILABLE)))
cases << reversal("reversed: a failed payout is left alone", ok(payout_json("failed", TXN_AVAILABLE)))
cases << reversal("reversed: a failed payout with a pending balance transaction is left alone", ok(payout_json("failed", TXN_PENDING)))
cases << reversal("reversed: a payout without a balance transaction fails on nil", ok(payout_json("failed", nil)))
cases << reversal("reversed: a payout whose balance transaction is missing fails on nil", ok(payout_json("paid", :absent)))
cases << reversal("reversed: a balance transaction that was not expanded never completes", ok(payout_json("paid", "txn_1")))
cases << reversal("reversed: a failed payout with an unexpanded balance transaction is left alone", ok(payout_json("failed", "txn_1")))
cases << reversal("reversed: Stripe does not know the payout", [404, { "Content-Type" => "application/json", "Request-Id" => "req_404" },
                                                                { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payout: 'po_rev'", param: "payout" } }.to_json])
cases << reversal("reversed: Stripe fails", [500, { "Content-Type" => "application/json", "Request-Id" => "req_500" }, { error: { type: "api_error", message: "Something went wrong" } }.to_json])

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
