# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/purchase-reads-jobs.golden.json: the jobs that only
# need to read purchases and subscriptions, run by the real app against a scratch database, each
# case as a Sidekiq job (support/sidekiq_executor.rb). Run it like user-writes.rb, adding
# USE_DB_WORKER_REPLICAS=true.
#
# The purchase factory charges Stripe, so purchases are plain INSERTs: only the columns a read looks
# at are set (every purchases column is nullable or defaulted). Jobs that write through Purchase
# callbacks are recorded to the point Node hands them back; Stripe is pointed at a closed local port
# so a stray charge-processor call fails fast.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/purchase-reads-jobs.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[purchases subscriptions url_redirects events users links].freeze
IS_TEST_SUBSCRIPTION = 1
CHARGEBACK_REVERSED = 1 << 9

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0

# ActiveJob's job_id is SecureRandom.uuid; sequential values keep the payloads comparable.
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default
Rails.logger = ActiveSupport::Logger.new(nil)

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def subscription_row(id, **overrides)
  { id:, link_id: 1, user_id: 1, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def redirect_row(id, purchase_id, **overrides)
  { id:, purchase_id:, token: "token#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rental_redirect(id, purchase_id, **overrides) = redirect_row(id, purchase_id, flags: 4, **overrides)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

# Bulk rows go in with one INSERT in `setup:`, so the golden does not carry thousands of seed statements.
def bulk_insert(table, rows)
  c = ActiveRecord::Base.connection
  columns = rows.first.keys
  values = rows.map { |row| "(#{row.values.map { c.quote(_1) }.join(", ")})" }.join(", ")
  c.execute("INSERT INTO #{c.quote_table_name(table)} (#{columns.map { c.quote_column_name(_1) }.join(", ")}) VALUES #{values}")
end

# `bulk:` cases insert thousands of rows in `setup:`; their table dumps (and, past a few keys, the Redis
# state) are summarised so the golden stays small. The summary lists the jobs pushed, in queue order.
def run(name, job, args, seed: {}, setup: nil, bulk: false)
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job:, args:) { job.constantize.new.perform(*args) }
  return result unless bulk

  result.delete("rows")
  redis = result["redis"]
  result["redis"] = {
    "keys" => redis.transform_values { |entry| entry.slice("type").merge("count" => entry["value"].is_a?(Array) ? entry["value"].size : 1) },
    "queue_args" => (redis.dig("queue:default", "value") || []).map { JSON.parse(_1)["args"] },
  } if redis.size > 40
  result
end

cases = []

# UpdatePurchaseHealthcheckThresholdJob: each window is the 10 minutes ending N days before NOW.
def window_purchases(days_ago, count, state: "successful")
  ended_at = NOW - days_ago.days
  Array.new(count) { |i| purchase_row(0, purchase_state: state, created_at: (ended_at - 1.minute - i.seconds).utc.strftime("%Y-%m-%d %H:%M:%S")).except(:id) }
end

def seed_windows(counts, **options)
  -> { bulk_insert("purchases", counts.each_with_index.flat_map { |count, index| window_purchases(index + 1, count, **options) }) }
end

cases << run("no history falls back to the minimum", "UpdatePurchaseHealthcheckThresholdJob", [])
cases << run("half the median of the prior week", "UpdatePurchaseHealthcheckThresholdJob", [], setup: seed_windows([300, 500, 420, 260, 800, 410, 380]), bulk: true)
cases << run("a median that rounds half up", "UpdatePurchaseHealthcheckThresholdJob", [], setup: seed_windows([301, 301, 301, 301, 301, 301, 301]), bulk: true)
cases << run("a quiet week stays at the minimum", "UpdatePurchaseHealthcheckThresholdJob", [], setup: seed_windows([10, 20, 30, 40, 50, 60, 70]), bulk: true)
cases << run("only successful purchases inside the window count", "UpdatePurchaseHealthcheckThresholdJob", [], bulk: true, setup: lambda {
  seed_windows([250, 250, 250, 250, 250, 250, 250]).call
  bulk_insert("purchases", window_purchases(1, 400, state: "failed") + window_purchases(2, 400, state: "in_progress"))
  # Outside every window: after the window's end, and before its start.
  bulk_insert("purchases", [purchase_row(0, created_at: (NOW - 1.day + 1.minute).utc.strftime("%Y-%m-%d %H:%M:%S")).except(:id),
                            purchase_row(0, created_at: (NOW - 1.day - 11.minutes).utc.strftime("%Y-%m-%d %H:%M:%S")).except(:id)])
})

# FindExpiredSubscriptionsToSetAsDeactivatedWorker
PAST = "2025-10-01 00:00:00"
FUTURE = "2025-12-01 00:00:00"
cases << run("no subscriptions", "FindExpiredSubscriptionsToSetAsDeactivatedWorker", [])
cases << run("enqueues cancelled, failed and ended subscriptions in that order", "FindExpiredSubscriptionsToSetAsDeactivatedWorker", [], seed: {
  subscriptions: [
    subscription_row(1, ended_at: PAST),
    subscription_row(2, cancelled_at: PAST),
    subscription_row(3, failed_at: PAST),
    subscription_row(4, cancelled_at: PAST, failed_at: PAST, ended_at: PAST),
    subscription_row(5, cancelled_at: FUTURE),
    subscription_row(6, cancelled_at: PAST, deactivated_at: PAST),
    subscription_row(7, cancelled_at: PAST, flags: IS_TEST_SUBSCRIPTION),
    subscription_row(8, cancelled_at: PAST, flags: IS_TEST_SUBSCRIPTION | 2),
    subscription_row(9, cancelled_at: PAST, flags: 2),
    subscription_row(10),
  ],
})
cases << run("a relation spanning more than one batch", "FindExpiredSubscriptionsToSetAsDeactivatedWorker", [],
             setup: -> { bulk_insert("subscriptions", Array.new(1001) { |i| subscription_row(i + 1, cancelled_at: PAST) }) }, bulk: true)

# SendRentalExpiresSoonEmailWorker
RENTAL = 1
rental_args = [1, 86_400 * 2]
cases << run("rental: purchase does not exist", "SendRentalExpiresSoonEmailWorker", rental_args)
cases << run("rental: purchase without a url redirect", "SendRentalExpiresSoonEmailWorker", rental_args, seed: { purchases: [purchase_row(1)] })
cases << run("rental: redirect is not a rental", "SendRentalExpiresSoonEmailWorker", rental_args, seed: { purchases: [purchase_row(1)], url_redirects: [redirect_row(1, 1)] })
cases << run("rental: already viewed", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: 1 << 14)], url_redirects: [rental_redirect(1, 1, rental_first_viewed_at: "2025-10-30 00:00:00")],
})
cases << run("rental: charged back", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: 1 << 14, chargeback_date: "2025-10-30 00:00:00")], url_redirects: [rental_redirect(1, 1)],
})
cases << run("rental: charge back reversed", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: (1 << 14) | CHARGEBACK_REVERSED, chargeback_date: "2025-10-30 00:00:00")], url_redirects: [rental_redirect(1, 1)],
})
cases << run("rental: refunded", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: 1 << 14, stripe_refunded: true)], url_redirects: [rental_redirect(1, 1)],
})
cases << run("rental: partly refunded is not refunded", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: 1 << 14, stripe_partially_refunded: true)], url_redirects: [rental_redirect(1, 1)],
})
cases << run("rental: queues the reminder", "SendRentalExpiresSoonEmailWorker", rental_args, seed: {
  purchases: [purchase_row(1, flags: 1 << 14)], url_redirects: [rental_redirect(1, 1)],
})
cases << run("rental: two url redirects, the first one counts", "SendRentalExpiresSoonEmailWorker", [1, 3600], seed: {
  purchases: [purchase_row(1, flags: 1 << 14)], url_redirects: [rental_redirect(2, 1, rental_first_viewed_at: "2025-10-30 00:00:00"), rental_redirect(1, 1)],
})

# ExpireRentalPurchasesWorker: Node hands the job back as soon as the read finds a purchase.
cases << run("expire rentals: nothing to expire", "ExpireRentalPurchasesWorker", [])
cases << run("expire rentals: only recent or already expired rentals", "ExpireRentalPurchasesWorker", [], seed: {
  purchases: [purchase_row(1, rental_expired: false), purchase_row(2, rental_expired: true), purchase_row(3, rental_expired: false), purchase_row(4)],
  url_redirects: [rental_redirect(1, 1, created_at: "2025-10-20 00:00:00"), rental_redirect(2, 2, created_at: "2025-01-01 00:00:00"),
                  rental_redirect(3, 3, created_at: "2025-10-20 00:00:00", rental_first_viewed_at: "2025-10-30 00:00:00"), rental_redirect(4, 4, created_at: "2025-01-01 00:00:00")],
})
cases << run("expire rentals: a rental past its window", "ExpireRentalPurchasesWorker", [], seed: {
  purchases: [purchase_row(1, rental_expired: false, flags: 1 << 14)], url_redirects: [rental_redirect(1, 1, created_at: "2025-09-01 00:00:00")],
})
cases << run("expire rentals: a rental watched more than 72 hours ago", "ExpireRentalPurchasesWorker", [], seed: {
  purchases: [purchase_row(1, rental_expired: false, flags: 1 << 14)], url_redirects: [rental_redirect(1, 1, created_at: "2025-10-30 00:00:00", rental_first_viewed_at: "2025-10-28 00:00:00")],
})

# SyncStuckPurchasesJob: Node hands the job back as soon as the read finds a purchase.
cases << run("sync stuck: nothing in progress", "SyncStuckPurchasesJob", [], seed: { purchases: [purchase_row(1), purchase_row(2, purchase_state: "failed")] })
cases << run("sync stuck: in progress outside the window", "SyncStuckPurchasesJob", [], seed: {
  purchases: [purchase_row(1, purchase_state: "in_progress", created_at: "2025-11-01 11:00:00"), purchase_row(2, purchase_state: "in_progress", created_at: "2025-10-20 00:00:00")],
})
cases << run("sync stuck: in progress inside the window", "SyncStuckPurchasesJob", [], seed: {
  purchases: [purchase_row(1, purchase_state: "in_progress", created_at: "2025-11-01 04:00:00")],
})

# CreateMissingPurchaseEventsWorker: Node hands the job back as soon as the read finds a purchase.
cases << run("missing events: none missing", "CreateMissingPurchaseEventsWorker", [], seed: {
  purchases: [purchase_row(1, created_at: "2025-10-31 08:00:00"), purchase_row(2, created_at: "2025-10-31 09:00:00", preorder_id: 5), purchase_row(3, created_at: "2025-10-30 09:00:00"),
              purchase_row(4, created_at: "2025-10-31 10:00:00", purchase_state: "failed")],
  events: [{ id: 1, event_name: "purchase", purchase_id: 1, link_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << run("missing events: an explicit date", "CreateMissingPurchaseEventsWorker", ["2025-10-30"], seed: { purchases: [purchase_row(1, created_at: "2025-10-30 08:00:00")] })
cases << run("missing events: a purchase without an event", "CreateMissingPurchaseEventsWorker", [], seed: {
  purchases: [purchase_row(1, created_at: "2025-10-31 08:00:00"), purchase_row(2, created_at: "2025-10-31 09:00:00")],
  users: [user_row(1, timezone: "Tokyo")],
})

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
