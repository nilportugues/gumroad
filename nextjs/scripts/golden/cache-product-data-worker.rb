# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/cache-product-data-worker.golden.json: CacheProductDataWorker run by the real
# app as a Sidekiq job (support/sidekiq_executor.rb) over the seeded databases of link-metrics.rb and a real Elasticsearch
# purchases index reached through the recording proxy. Each case holds the statements (the cache expiry, the five metrics, the
# INSERT of the new ProductCachedValue), the Elasticsearch requests with their answers, the cache deletes and the rows left.
# Run it like link-metrics.rb.
require_relative "support/rails_cases"
require_relative "support/link_metrics_universe"
require_relative "support/link_metrics_scenarios"
require_relative "../../src/server/search/__fixtures__/es_recording_proxy"
include RailsCases
include LinkMetricsUniverse
connect_recording_client!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/cache-product-data-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
INDEX = "ws30m-purchase#{ENV.fetch("PARITY_ES_INDEX_SUFFIX", "")}"
Purchase.index_name(INDEX)
Purchase.__elasticsearch__.create_index!(force: true)
Rails.logger = ActiveSupport::Logger.new(nil)

SEEDS = LinkMetricsScenarios.build.to_h { [_1[:name], _1[:seed]] }
SEEDS["a deleted product"] = { "users" => [user_row], "links" => [link_row(1, deleted_at: LinkMetricsScenarios::PAST)] }

def exchanges
  EsProxy.log.map { |entry| entry.except("response").merge("response" => JSON.parse(entry["response"]).except("took")) }
end

def worker_case(name, scenario, args, cached: [])
  seed = SEEDS.fetch(scenario).merge("product_cached_values" => cached)
  purchase_ids = seed.fetch("purchases", []).map { _1[:id] }
  recorded = []
  entry = capture(name, now: NOW, tables: TABLES, seed:, setup: -> { reindex_purchases!(purchase_ids) }, sidekiq: true, job: "CacheProductDataWorker", args:) do
    EsProxy.log.clear
    EsProxy.on = true
    CacheProductDataWorker.new.perform(*args)
  ensure
    EsProxy.on = false
    recorded = exchanges
  end
  entry.merge("exchanges" => recorded).except("seed", "redis", "redis_before")
end

cases = []
cases << worker_case("a product with no sales and no cached values", "no sales", [1])
cases << worker_case("sales, refunds and charge backs", "purchase states and exclusions", [1])
cases << worker_case("another product of the same seller", "purchase states and exclusions", [2])
cases << worker_case("one fresh cached value is expired and replaced", "no sales", [1], cached: [cached_row(1, 1)])
cases << worker_case("fresh and expired cached values", "no sales", [1], cached: [cached_row(1, 1), cached_row(2, 1, expired: true), cached_row(3, 1), cached_row(4, 1, expired: true)])
cases << worker_case("cached values of another product are kept", "purchase states and exclusions", [1], cached: [cached_row(1, 2), cached_row(2, 1)])
cases << worker_case("subscriptions round the monthly recurring revenue to cents", "subscriptions", [1])
cases << worker_case("a recurring product with one subscription", "subscriptions", [2])
cases << worker_case("monthly revenue of 0.125 rounds up to 0.13", "half cents of monthly revenue", [1])
cases << worker_case("monthly revenue of 0.625 rounds up to 0.63", "half cents of monthly revenue", [2])
cases << worker_case("a large yearly subscription is cut to ten figures", "a large yearly subscription", [1])
cases << worker_case("sales totals past 32 bits", "large numbers", [1])
cases << worker_case("monthly recurring revenue past the decimal column", "subscriptions with large amounts", [1])
cases << worker_case("pending revenue of a fixed-length product", "fixed-length subscriptions", [1])
cases << worker_case("pending revenue past the decimal column", "fixed-length subscriptions", [5])
cases << worker_case("a negative duration in months", "fixed-length subscriptions", [3])
cases << worker_case("an active subscription with no original purchase", "fixed-length subscriptions", [4])
cases << worker_case("an original purchase with no price", "fixed-length subscriptions", [7])
[[2, "stock left"], [1, "no stock limit"], [3, "oversold"], [25, "bundle with a versioned product"], [12, "single tier"], [33, "bundle of three"]].each do |id, label|
  cases << worker_case("remaining for sale: #{label}", "stock", [id])
end
cases << worker_case("a tier closed to new purchases on a tiered membership", "stock", [17])
cases << worker_case("a bundle variant that is a Sku", "stock", [35])
cases << worker_case("a soft-deleted product", "a deleted product", [1], cached: [cached_row(1, 1)])
cases << worker_case("a product that does not exist", "no sales", [9], cached: [cached_row(1, 1)])
cases << worker_case("an id given as a digit string", "no sales", ["1"], cached: [cached_row(1, 1)])
cases << worker_case("an id given as a float", "no sales", [1.0], cached: [cached_row(1, 1)])
cases << worker_case("a nil id", "no sales", [nil])
cases << worker_case("an id that is not a number", "no sales", ["abc"])
cases << worker_case("a negative id", "no sales", [-1])
cases << worker_case("an id past a bigint", "no sales", [2**70])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "index" => INDEX, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
EsClient.indices.delete(index: INDEX)
