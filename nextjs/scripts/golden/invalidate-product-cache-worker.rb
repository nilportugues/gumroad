# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/invalidate-product-cache-worker.golden.json: InvalidateProductCacheWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# delete-expired-oauth-device-authorizations-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/invalidate-product-cache-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_cached_values versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def cached_row(id, product_id, expired: false, **overrides)
  { id:, product_id:, expired:, successful_sales_count: 3, remaining_for_sale_count: nil, monthly_recurring_revenue: "0.0", revenue_pending: "0.0", total_usd_cents: 500,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, links: [link_row(1)], cached: [])
  capture(name, now: NOW, tables: TABLES, seed: { links:, product_cached_values: cached }, sidekiq: true, job: "InvalidateProductCacheWorker", args:) do
    InvalidateProductCacheWorker.new.perform(*args)
  end
end

cases = []
cases << run("a product with no cached values", [1])
cases << run("one fresh cached value", [1], cached: [cached_row(1, 1)])
cases << run("several fresh cached values", [1], cached: [cached_row(1, 1), cached_row(2, 1, successful_sales_count: nil), cached_row(3, 1)])
cases << run("cached values that are already expired", [1], cached: [cached_row(1, 1, expired: true), cached_row(2, 1, expired: true)])
cases << run("fresh and expired cached values", [1], cached: [cached_row(1, 1, expired: true), cached_row(2, 1), cached_row(3, 1, expired: true), cached_row(4, 1)])
cases << run("cached values of another product are kept", [1], links: [link_row(1), link_row(2)], cached: [cached_row(1, 2), cached_row(2, 1)])
cases << run("a deleted product", [1], links: [link_row(1, deleted_at: SEEDED_AT)], cached: [cached_row(1, 1)])
cases << run("a product that does not exist", [9], cached: [cached_row(1, 1)])
cases << run("an id given as a digit string", ["1"], cached: [cached_row(1, 1)])
cases << run("an id given as a float", [1.0], cached: [cached_row(1, 1)])
cases << run("a nil id", [nil], cached: [cached_row(1, 1)])
cases << run("an id that is not a number", ["abc"], cached: [cached_row(1, 1)])
cases << run("a negative id", [-1], cached: [cached_row(1, 1)])
cases << run("an id past a bigint", [2**70], cached: [cached_row(1, 1)])
cases << run("an id past 2**53", [2**53 + 1], links: [link_row(2**53 + 1)], cached: [cached_row(1, 2**53 + 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases.each { _1.delete("rows") } }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
