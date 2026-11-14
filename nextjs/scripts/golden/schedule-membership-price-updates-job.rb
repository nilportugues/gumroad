# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/schedule-membership-price-updates-job.golden.json: ScheduleMembershipPriceUpdatesJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A run that reaches a subscription is
# what Node hands back to Rails (plan changes and price recalculation are Rails'); those cases are recorded up to the first
# subscription check, which a marker exception stands in for. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/schedule-membership-price-updates-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/schedule-membership-price-updates-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links variant_categories base_variants subscriptions].freeze
APPLY_PRICE_CHANGES = 1 << 1
TIERED_MEMBERSHIP = 1 << 18

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Subscription.prepend(Module.new do
  def charges_completed? = raise(HandBackMarker)
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: TIERED_MEMBERSHIP,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def category_row(id, link_id) = { id:, link_id:, title: "Tier" }

def tier_row(id, category_id: 1, **overrides)
  { id:, type: "Variant", variant_category_id: category_id, name: "Tier #{id}", flags: APPLY_PRICE_CHANGES,
    subscription_price_change_effective_date: "2026-12-01", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def subscription_row(id, link_id = 1, **overrides)
  { id:, link_id:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def base_seed(link: link_row(1), tier: tier_row(1), category: category_row(1, 1), **rest) = { links: [link], variant_categories: [category], base_variants: [tier], **rest }

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ScheduleMembershipPriceUpdatesJob", args:) do
    ScheduleMembershipPriceUpdatesJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a tier that does not exist", [9], base_seed)
cases << run("a tier id as a digit string", ["1"], base_seed)
cases << run("a tier that does not apply price changes to existing memberships", [1], base_seed(tier: tier_row(1, flags: 0)))
cases << run("a tier of a product that is not a tiered membership", [1], base_seed(link: link_row(1, flags: 0)))
cases << run("a tier of a deleted product", [1], base_seed(link: link_row(1, deleted_at: SEEDED_AT)))
cases << run("a tier of a product with no subscription", [1], base_seed)
cases << run("a tier of a product with only another product's subscription", [1], base_seed(subscriptions: [subscription_row(1, 2)]))
cases << run("a tier of a product with a subscription", [1], base_seed(subscriptions: [subscription_row(1)]))
cases << run("a tier of a product with an ended subscription", [1], base_seed(subscriptions: [subscription_row(1, ended_at: SEEDED_AT)]))
cases << run("a tier that is a deleted tier", [1], base_seed(tier: tier_row(1, deleted_at: SEEDED_AT)))
cases << run("a tier that is a SKU", [1], base_seed(tier: tier_row(1, type: "Sku")))
cases << run("a tier without a category", [1], base_seed(tier: tier_row(1, category_id: nil)))
cases << run("a tier whose category points at a product that does not exist", [1], base_seed(category: category_row(1, 9)))
cases << run("a tier whose category does not exist", [1], base_seed(tier: tier_row(1, category_id: 9)))
cases << run("a tier id of nil", [nil], base_seed)
cases << run("a tier id as a float", [1.0], base_seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
