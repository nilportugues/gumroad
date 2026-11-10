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
TABLES = %w[links base_variants variant_categories users versions].freeze
IS_TIERED_MEMBERSHIP = 1 << 18
CLOSED_TO_NEW_PURCHASES = 1 << 2

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def link_row(id, flags: IS_TIERED_MEMBERSHIP, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def category_row(id, link_id) = { id:, link_id:, title: "Tier", flags: 0 }

def tier_row(id, category_id, flags: CLOSED_TO_NEW_PURCHASES, **overrides)
  { id:, variant_category_id: category_id, type: "Variant", name: "Tier #{id}", price_difference_cents: 0, flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, links, categories, tiers)
  capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1)], links:, variant_categories: categories, base_variants: tiers }, sidekiq: true,
                job: "RefreshClosedTierDiscoverPricesJob", args: []) do
    RefreshClosedTierDiscoverPricesJob.new.perform
  end
end

cases = []
cases << run("no products", [], [], [])
cases << run("a membership with one closed tier", [link_row(1)], [category_row(1, 1)], [tier_row(1, 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases.each { _1.delete("rows"); _1.delete("seed") } }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
