# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-closed-tier-discover-prices-job.golden.json: RefreshClosedTierDiscoverPricesJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch captured
# (EsCapture). Run it like publish-scheduled-post.rb (env as in its header).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-closed-tier-discover-prices-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links base_variants variant_categories users prices versions].freeze
IS_TIERED_MEMBERSHIP = 1 << 18
CLOSED_TO_NEW_PURCHASES = 1 << 2
IS_RENTAL_PRICE = 1

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def link_row(id, flags: IS_TIERED_MEMBERSHIP, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def category_row(id, link_id, **overrides) = { id:, link_id:, title: "Tier", flags: 0 }.merge(overrides)

def tier_row(id, category_id, flags: CLOSED_TO_NEW_PURCHASES, **overrides)
  { id:, variant_category_id: category_id, type: "Variant", name: "Tier #{id}", price_difference_cents: 0, flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def price_row(id, variant_id, cents, **overrides) = { id:, variant_id:, price_cents: cents, currency: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, links, categories, tiers, prices: [], users: [user_row(1)])
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, links:, variant_categories: categories, base_variants: tiers, prices: }, sidekiq: true,
                         job: "RefreshClosedTierDiscoverPricesJob", args: []) do
    RefreshClosedTierDiscoverPricesJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

cases = []
cases << run("no products", [], [], [])
cases << run("a membership with one closed tier", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1)])
cases << run("a closed tier with prices", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1)], prices: [price_row(1, 1, 500), price_row(2, 1, 1500), price_row(3, 1, 900, **DELETED), price_row(4, 1, 700, flags: IS_RENTAL_PRICE)])
cases << run("a closed tier next to an open one", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1), tier_row(2, 1, flags: 0)], prices: [price_row(1, 1, 500), price_row(2, 2, 300)])
cases << run("two closed tiers of one membership are touched once", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1), tier_row(2, 1)], prices: [price_row(1, 1, 500), price_row(2, 2, 300)])
cases << run("an open tier only", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1, flags: 0)])
cases << run("a closed tier that is deleted", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1, **DELETED)])
cases << run("a closed tier in a deleted category", [link_row(1)], [category_row(1, 1, **DELETED)], [tier_row(1, 1)])
cases << run("a closed version in a category not named Tier", [link_row(1)], [category_row(1, 1, title: "Versions")], [tier_row(1, 1)])
cases << run("a closed tier of a product that is not a tiered membership", [link_row(1, flags: 0)], [category_row(1, 1)], [tier_row(1, 1)])
cases << run("a closed SKU", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1, type: "Sku")])
cases << run("a closed tier with other flags set", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1, flags: 7)])
cases << run("a deleted membership", [link_row(1, **DELETED)], [category_row(1, 1)], [tier_row(1, 1)])
cases << run("two memberships and one without a closed tier", [link_row(1), link_row(2), link_row(3)], [category_row(1, 1), category_row(2, 2), category_row(3, 3)], [tier_row(1, 1), tier_row(2, 2, flags: 0), tier_row(3, 3)], prices: [price_row(1, 1, 100), price_row(2, 3, 250)])
cases << run("a membership whose seller is missing", [link_row(1, user_id: 99)], [category_row(1, 1)], [tier_row(1, 1)], users: [])
cases << run("a membership with a name that needs escaping", [link_row(1, name: "Tier's <b> & \"co\"")], [category_row(1, 1)], [tier_row(1, 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
