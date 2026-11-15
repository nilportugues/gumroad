# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/regenerate-creator-analytics-cache-worker.golden.json: RegenerateCreatorAnalyticsCacheWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with the real CreatorAnalytics::CachingProxy,
# Web, Sales and ProductPageViews. Elasticsearch is the canned socket of support/rails_cases.rb: every request is recorded under "es" and
# answered with the next body of the case (composite buckets, in the order Rails asks: views then sales for each of date, state, referral).
# `marks` is what the analytics cache version key of the main Redis ($redis) held. Run it like repair-order-charge-outcomes-job.rb
# (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/regenerate-creator-analytics-cache-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links purchases large_sellers computed_sales_analytics_days].freeze
VERSION_KEY = RedisKey.seller_analytics_cache_version
PACIFIC = "Pacific Time (US & Canada)"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, link_id, **overrides) = { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: "2026-02-03 10:00:00", updated_at: SEEDED_AT }.merge(overrides)

def large_seller_row(user_id = 1) = { id: user_id, user_id:, sales_count: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def cache_row(id, key, data) = { id:, key:, data: data.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def key_for(date, by, version: 0, timezone: PACIFIC, user_id: 1)
  key = "seller_analytics_v#{version}_user_#{user_id}_#{timezone}_by_#{by}_for_#{date}_revenue_v1"
  by == "referral" ? "#{key}_v1" : key
end

def agg(buckets) = { "aggregations" => { "composite_agg" => { "buckets" => buckets } } }

def views(key, count) = { "key" => key, "doc_count" => count }

def sale(key, count, total) = { "key" => key, "doc_count" => count, "total" => { "value" => total.to_f } }

# The six answers for date, state and referral: views then sales.
def answers(date)
  [
    agg([views({ "product_id" => 1, "date" => date }, 7)]),
    agg([sale({ "product_id" => 1, "date" => date }, 3, 1500)]),
    agg([views({ "product_id" => 1, "country" => "United States", "state" => "CA" }, 4), views({ "product_id" => 1, "country" => "Canada", "state" => nil }, 2), views({ "product_id" => 1, "country" => nil, "state" => nil }, 1)]),
    agg([sale({ "product_id" => 1, "country" => "United States", "state" => "NY" }, 2, 900), sale({ "product_id" => 1, "country" => "France", "state" => nil }, 1, 600), sale({ "product_id" => 1, "country" => "United States", "state" => "Narnia" }, 1, 100)]),
    agg([views({ "product_id" => 1, "referrer_domain" => "twitter.com", "date" => date }, 5), views({ "product_id" => 1, "referrer_domain" => "", "date" => date }, 2)]),
    agg([sale({ "product_id" => 1, "referrer_domain" => "twitter.com", "date" => date }, 2, 1000), sale({ "product_id" => 1, "referrer_domain" => "direct.example.org", "date" => date }, 1, 500)]),
  ]
end

def run(name, args, users: [user_row(1)], links: [link_row(1)], purchases: [purchase_row(1, 1)], large: [large_seller_row], cached: [], es: nil, version: nil)
  before = nil
  setup = lambda do
    $redis.del(VERSION_KEY)
    $redis.set(VERSION_KEY, version) if version
    before = $redis.get(VERSION_KEY)
  end
  seed = { users:, links:, purchases:, large_sellers: large, computed_sales_analytics_days: cached }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "RegenerateCreatorAnalyticsCacheWorker", args:, es_bodies: es || answers(args[1].to_s)) do
    RegenerateCreatorAnalyticsCacheWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("redis_before")
  result["marks_before"] = before
  result["marks"] = $redis.get(VERSION_KEY)
  result
end

DAY = "2026-10-20"
cases = []
cases << run("a seller that does not exist", [99, DAY], users: [], links: [], purchases: [], large: [])
cases << run("a seller id of nil", [nil, DAY])
cases << run("a seller and a date that is not a date", [1, "never"])
cases << run("a seller and a date of nil", [1, nil])
cases << run("a large seller and a date", [1, DAY])
cases << run("a date given as a datetime string", [1, "2026-10-20T10:00:00Z"])
cases << run("a date given in a slash format", [1, "2026/10/20"])
cases << run("a seller that is not large", [1, DAY], large: [])
cases << run("a date before the tracking started", [1, "2012-10-12"])
cases << run("the day tracking started", [1, "2012-10-13"])
cases << run("the last date that is cached", [1, "2026-11-02"])
cases << run("a date after the last one that is cached", [1, "2026-11-03"])
cases << run("today", [1, "2026-11-04"])
cases << run("a date in the future", [1, "2027-01-01"])
cases << run("a seller that is not large and a date before tracking", [1, "2012-10-12"], large: [])
cases << run("a date that exists only in some months", [1, "2026-02-30"])
cases << run("a large seller without products", [1, DAY], links: [], purchases: [])
cases << run("a large seller without sales", [1, DAY], purchases: [])
cases << run("a large seller with several products and sales", [1, DAY], links: [link_row(1), link_row(2), link_row(3, deleted_at: SEEDED_AT)], purchases: [purchase_row(1, 1), purchase_row(2, 2, created_at: "2026-01-05 09:00:00"), purchase_row(3, 3)])
cases << run("an archived product without sales is left out", [1, DAY], links: [link_row(1, flags: 1 << 5), link_row(2)], purchases: [purchase_row(1, 2)])
cases << run("a preorder sale is the first sale", [1, DAY], purchases: [purchase_row(1, 1, purchase_state: "preorder_authorization_successful", created_at: "2026-01-01 08:00:00"), purchase_row(2, 1, created_at: "2026-03-01 08:00:00")])
cases << run("a seller in another time zone", [1, DAY], users: [user_row(1, timezone: "Tokyo")])
cases << run("a seller in a time zone behind Pacific", [1, "2026-11-02"], users: [user_row(1, timezone: "Hawaii")])
cases << run("a seller in a time zone ahead of UTC and the last cached date", [1, "2026-11-03"], users: [user_row(1, timezone: "Auckland")])
cases << run("a seller in UTC", [1, DAY], users: [user_row(1, timezone: "UTC")])
cases << run("a day with a daylight saving change", [1, "2026-11-01"])
cases << run("the first day of the year", [1, "2026-01-01"])
cases << run("a cache version in Redis", [1, DAY], version: "3")
cases << run("a cache version that is not a number", [1, DAY], version: "abc")
cases << run("existing cached days that differ are overwritten", [1, DAY], cached: [cache_row(1, key_for(DAY, "date"), { "old" => 1 }), cache_row(2, key_for(DAY, "state"), { "old" => 2 }), cache_row(3, key_for(DAY, "referral"), { "old" => 3 })])
cases << run("an existing cached day for one type only", [1, DAY], cached: [cache_row(1, key_for(DAY, "state"), { "old" => 2 })])
cases << run("cached days of other dates are kept", [1, DAY], cached: [cache_row(1, key_for("2026-10-19", "date"), { "old" => 1 }), cache_row(2, key_for(DAY, "date", version: 9), { "old" => 2 })])
cases << run("a cached day that Rails would write the same", [1, DAY], es: answers(DAY), cached: [cache_row(1, key_for(DAY, "date"), "x")])
cases << run("no buckets from Elasticsearch", [1, DAY], es: Array.new(6) { agg([]) })
cases << run("buckets for a product the seller does not have", [1, DAY], es: [agg([views({ "product_id" => 7, "date" => DAY }, 1)]), agg([]), agg([]), agg([]), agg([]), agg([])])
cases << run("a bucket for a date outside the day", [1, DAY], es: [agg([]), agg([]), agg([]), agg([]), agg([views({ "product_id" => 1, "referrer_domain" => "twitter.com", "date" => "2026-10-21" }, 1)]), agg([])])
cases << run("sales with a fractional total", [1, DAY], es: [agg([]), agg([sale({ "product_id" => 1, "date" => DAY }, 3, 1500.75)]), agg([]), agg([]), agg([]), agg([sale({ "product_id" => 1, "referrer_domain" => "t.co", "date" => DAY }, 3, 99.5)])])
cases << run("a suspended seller", [1, DAY], users: [user_row(1, user_risk_state: "suspended_for_fraud")])
cases << run("a deleted seller", [1, DAY], users: [user_row(1, deleted_at: SEEDED_AT)])
cases << run("a seller id given as a digit string", ["1", DAY])
cases << run("a seller id given as a float", [1.0, DAY])
cases << run("a seller id given as a word", ["abc", DAY])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
