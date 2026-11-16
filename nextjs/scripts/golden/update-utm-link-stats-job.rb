# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-utm-link-stats-job.golden.json: UpdateUtmLinkStatsJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/update-utm-link-stats-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-utm-link-stats-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
CLICKED_AT = "2026-01-02 00:00:00"
TABLES = %w[users utm_links utm_link_visits versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", name: "User #{id}", external_id: (1000 + id).to_s,
    recommendation_type: "own_products", user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT,
    created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def link_row(id, **overrides)
  {
    id:, seller_id: 1, title: "Link #{id}", target_resource_type: "profile_page", target_resource_id: nil, permalink: format("link%04d", id),
    utm_source: "source#{id}", utm_medium: "medium", utm_campaign: "campaign", total_clicks: 0, unique_clicks: 0,
    created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def visit_row(id, link_id, guid, **overrides)
  { id:, utm_link_id: link_id, ip_address: "203.0.113.1", browser_guid: guid, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdateUtmLinkStatsJob", args:) do
    UpdateUtmLinkStatsJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

SELLER = { users: [user_row(1)] }.freeze

def one_visit = { utm_link_visits: [visit_row(1, 1, "a")] }

cases = []
cases << run("the link does not exist", [99], seed: SELLER)
cases << run("a link with no visits and zero counters", [1], seed: SELLER.merge(utm_links: [link_row(1)]))
cases << run("a link with no visits and stale counters", [1], seed: SELLER.merge(utm_links: [link_row(1, total_clicks: 5, unique_clicks: 3)]))
cases << run("counters already correct", [1], seed: SELLER.merge(utm_links: [link_row(1, total_clicks: 2, unique_clicks: 2)], utm_link_visits: [visit_row(1, 1, "a"), visit_row(2, 1, "b")]))
cases << run("visits from distinct browsers", [1], seed: SELLER.merge(utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "a"), visit_row(2, 1, "b"), visit_row(3, 1, "c")]))
cases << run("repeat visits from one browser", [1], seed: SELLER.merge(utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "a"), visit_row(2, 1, "a"), visit_row(3, 1, "b")]))
cases << run("browser guids that differ only by case", [1], seed: SELLER.merge(utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "abc"), visit_row(2, 1, "ABC")]))
cases << run("visits of other links are ignored", [1], seed: SELLER.merge(utm_links: [link_row(1), link_row(2)], utm_link_visits: [visit_row(1, 1, "a"), visit_row(2, 2, "a"), visit_row(3, 2, "b")]))
cases << run("only the unique counter is stale", [1], seed: SELLER.merge(utm_links: [link_row(1, total_clicks: 2, unique_clicks: 2)], utm_link_visits: [visit_row(1, 1, "a"), visit_row(2, 1, "a")]))
cases << run("a soft-deleted link", [1], seed: SELLER.merge(utm_links: [link_row(1, deleted_at: "2026-02-01 00:00:00")], **one_visit))
cases << run("a disabled link", [1], seed: SELLER.merge(utm_links: [link_row(1, disabled_at: "2026-02-01 00:00:00")], **one_visit))
cases << run("a link with click timestamps in order", [1], seed: SELLER.merge(utm_links: [link_row(1, first_click_at: SEEDED_AT, last_click_at: CLICKED_AT)], **one_visit))
cases << run("a link whose last click precedes its first", [1], seed: SELLER.merge(utm_links: [link_row(1, first_click_at: CLICKED_AT, last_click_at: SEEDED_AT)], **one_visit))
cases << run("a link with a last click and no first click", [1], seed: SELLER.merge(utm_links: [link_row(1, last_click_at: SEEDED_AT)], **one_visit))
cases << run("a link whose seller is gone", [1], seed: { utm_links: [link_row(1, seller_id: 7)], **one_visit })
cases << run("a link with a blank title", [1], seed: SELLER.merge(utm_links: [link_row(1, title: "")], **one_visit))
cases << run("a link with an unknown target type", [1], seed: SELLER.merge(utm_links: [link_row(1, target_resource_type: "other_page")], **one_visit))
cases << run("a product page link with no resource id", [1], seed: SELLER.merge(utm_links: [link_row(1, target_resource_type: "product_page")], **one_visit))
cases << run("a link with a malformed permalink", [1], seed: SELLER.merge(utm_links: [link_row(1, permalink: "ABC")], **one_visit))
cases << run("the id as digits", ["1"], seed: SELLER.merge(utm_links: [link_row(1)], **one_visit))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
