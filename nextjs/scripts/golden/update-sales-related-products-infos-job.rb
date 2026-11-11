# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-sales-related-products-infos-job.golden.json:
# UpdateSalesRelatedProductsInfosJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# The feature flag and the delay key are set in Redis before each case (`redis_before`); Kernel#rand, the retry sleep and a
# deadlock on the upsert are pinned so the schedule and the retries are reproducible. Run it like
# regenerate-sales-related-products-infos-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-sales-related-products-infos-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links purchases sales_related_products_infos].freeze
FEATURE = :update_sales_related_products_infos
DELAY_KEY = RedisKey.update_cached_srpis_job_delay_hours
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]
IS_GIFT_RECEIVER_PURCHASE = Purchase.flag_mapping["flags"][:is_gift_receiver_purchase]

Rails.logger = ActiveSupport::Logger.new(nil)

$rands = []
$rands_used = []
UpdateSalesRelatedProductsInfosJob.prepend(Module.new do
  def rand(*args)
    value = $rands.shift or raise "no pinned rand left"
    $rands_used << [args, value]
    value
  end
end)

# The retry's jitter (`Kernel.rand`) and sleep.
$sleeps = []
Kernel.singleton_class.prepend(Module.new do
  def rand(*args)
    return super unless args.empty? && $retry_rands
    $rands_used << [[], $retry_rands.first]
    $retry_rands.first
  end
end)
SalesRelatedProductsInfo.singleton_class.prepend(Module.new do
  def sleep(seconds)
    $sleeps << seconds
  end
end)

# A deadlock on the next `$deadlocks` upserts, reported by MySQL before the statement does anything.
$deadlocks = 0
Mysql2::Client.prepend(Module.new do
  def query(sql, *rest, **options)
    if $deadlocks.positive? && sql.start_with?("INSERT INTO sales_related_products_infos")
      $deadlocks -= 1
      error = Mysql2::Error.new("Deadlock found when trying to get lock; try restarting transaction", nil, 1213, "40001")
      RailsRecorder.record_error(sql, error)
      raise error
    end
    super
  end
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, link_id, email, **overrides)
  { id:, link_id:, seller_id: 1, email:, purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def info_row(id, smaller, larger, count = 5) = { id:, smaller_product_id: smaller, larger_product_id: larger, sales_count: count, created_at: SEEDED_AT, updated_at: SEEDED_AT }

# Buyer a@ owns products 1, 2 and 3 (purchase 1 is product 1); b@ owns 1 and 2.
BASE = [
  purchase_row(1, 1, "a@example.com"), purchase_row(2, 2, "a@example.com"), purchase_row(3, 3, "a@example.com"),
  purchase_row(4, 1, "b@example.com"), purchase_row(5, 2, "b@example.com"),
].freeze

def run(name, args, purchases: BASE, infos: [], feature: true, delay: nil, rands: nil, deadlocks: 0, retry_rands: nil)
  $rands.replace(rands || Array.new(10) { |i| 1000 + i })
  $rands_used.clear
  $sleeps.clear
  $deadlocks = deadlocks
  $retry_rands = retry_rands
  result = capture(name, now: NOW, tables: TABLES, seed: { links: (1..5).map { link_row(_1) }, purchases:, sales_related_products_infos: infos }, sidekiq: true,
                         job: "UpdateSalesRelatedProductsInfosJob", args:, case_now: NOW.to_f, setup: lambda {
    Feature.activate(FEATURE) if feature
    redis.set(DELAY_KEY, delay) if delay
  }) { UpdateSalesRelatedProductsInfosJob.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result.merge("rands_used" => $rands_used.dup, "sleeps" => $sleeps.dup)
end

cases = []
cases << run("the feature is inactive", [1], feature: false)
cases << run("a purchase that does not exist", [99])
cases << run("a buyer who owns other products", [1])
cases << run("a reversal", [1, false], infos: [info_row(1, 1, 2, 3), info_row(2, 1, 3, 1)])
cases << run("an increment is the default and true is accepted", [1, true])
cases << run("existing pairs are incremented", [1], infos: [info_row(1, 1, 2, 3), info_row(2, 2, 3, 7)])
cases << run("a reversal of a pair that does not exist starts at zero", [1, false])
cases << run("a buyer who owns nothing else", [3], purchases: [purchase_row(1, 1, "a@example.com"), purchase_row(3, 3, "z@example.com")])
cases << run("the product's own other purchases do not pair with it", [1], purchases: [purchase_row(1, 1, "a@example.com"), purchase_row(2, 1, "a@example.com")])
cases << run("a delay set in redis", [1], delay: "5")
cases << run("a delay of zero", [1], delay: "0")
cases << run("a delay that is not a number", [1], delay: "soon")
cases << run("a negative delay", [1], delay: "-3")
cases << run("a delay with a fraction and trailing text", [1], delay: "2.9 hours")
cases << run("purchase states", [1], purchases: [
  purchase_row(1, 1, "a@example.com"),
  purchase_row(2, 2, "a@example.com", purchase_state: "preorder_authorization_successful"),
  purchase_row(3, 3, "a@example.com", purchase_state: "gift_receiver_purchase_successful"),
  purchase_row(4, 4, "a@example.com", purchase_state: "failed"),
  purchase_row(5, 5, "a@example.com", purchase_state: "in_progress"),
])
cases << run("refunded and charged back purchases", [1], purchases: [
  purchase_row(1, 1, "a@example.com"),
  purchase_row(2, 2, "a@example.com", stripe_refunded: true),
  purchase_row(3, 3, "a@example.com", stripe_refunded: false),
  purchase_row(4, 4, "a@example.com", chargeback_date: "2026-02-01 00:00:00"),
  purchase_row(5, 5, "a@example.com", chargeback_date: "2026-02-01 00:00:00", flags: CHARGEBACK_REVERSED),
])
cases << run("a gift receiver purchase", [1], purchases: [
  purchase_row(1, 1, "a@example.com"), purchase_row(2, 2, "a@example.com", flags: IS_GIFT_RECEIVER_PURCHASE), purchase_row(3, 3, "a@example.com"),
])
cases << run("the buyer's other products ordered by their latest purchase", [3], purchases: [
  purchase_row(1, 3, "a@example.com"), purchase_row(2, 1, "a@example.com"), purchase_row(3, 2, "a@example.com"), purchase_row(4, 1, "a@example.com"),
  purchase_row(5, 4, "a@example.com"), purchase_row(6, 2, "a@example.com"),
])
cases << run("the same product bought twice", [1], purchases: [
  purchase_row(1, 1, "a@example.com"), purchase_row(2, 2, "a@example.com"), purchase_row(3, 2, "a@example.com"),
])
cases << run("101 related products keep the 100 latest", [1], purchases:
  [purchase_row(1, 1, "a@example.com")] + (2..102).map { purchase_row(_1, _1, "a@example.com") }, rands: Array.new(102) { 2000 + _1 })
cases << run("a purchase email in another case", [1], purchases: [purchase_row(1, 1, "A@example.com"), purchase_row(2, 2, "a@EXAMPLE.com")])
cases << run("a deadlock on the upsert is retried", [1], deadlocks: 1, retry_rands: [0.5])
cases << run("two deadlocks are retried with a growing backoff", [1], deadlocks: 2, retry_rands: [0.25])
cases << run("four deadlocks fail the job", [1], deadlocks: 4, retry_rands: [0.75])
cases << run("a purchase id given as a string", ["1"])
cases << run("a purchase id given as a float", [1.0])
cases << run("an increment given as null", [1, nil], infos: [info_row(1, 1, 2, 3)])
cases << run("an increment given as a string", [1, "false"], infos: [info_row(1, 1, 2, 3)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
