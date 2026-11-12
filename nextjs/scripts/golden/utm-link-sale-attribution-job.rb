# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/utm-link-sale-attribution-job.golden.json: UtmLinkSaleAttributionJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/utm-link-sale-attribution-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/utm-link-sale-attribution-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
BOUGHT_AT = "2026-11-04 12:00:00"
TABLES = %w[orders order_purchases purchases utm_links utm_link_visits utm_link_driven_sales versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides)
  {
    id:, seller_id: 1, title: "Link #{id}", target_resource_type: "profile_page", target_resource_id: nil, permalink: format("link%04d", id),
    utm_source: "source#{id}", utm_medium: "medium", utm_campaign: "campaign", total_clicks: 0, unique_clicks: 0,
    created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def visit_row(id, link_id, at, guid: "guid", **overrides)
  { id:, utm_link_id: link_id, ip_address: "203.0.113.1", browser_guid: guid, created_at: at, updated_at: at }.merge(overrides)
end

def sale_row(id, seller: 1, product: 10, at: BOUGHT_AT, **overrides)
  { id:, seller_id: seller, link_id: product, purchase_state: "successful", country: "United States", created_at: at, updated_at: at }.merge(overrides)
end

# Orders 1 holds the given sales.
def order_with(*sales)
  { orders: [{ id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
    order_purchases: sales.map.with_index(1) { |sale, i| { id: i, order_id: 1, purchase_id: sale[:id], created_at: SEEDED_AT, updated_at: SEEDED_AT } },
    purchases: sales }
end

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UtmLinkSaleAttributionJob", args:) do
    UtmLinkSaleAttributionJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

def attributed(seed) = seed.merge(utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")])

cases = []
cases << run("an order that does not exist", [9, "guid"])
cases << run("an order with no purchases", [1, "guid"], seed: { orders: [{ id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("a purchase that was not successful", [1, "guid"], seed: attributed(order_with(sale_row(1, purchase_state: "failed"))))
cases << run("a visit that claims the purchase", [1, "guid"], seed: attributed(order_with(sale_row(1))))
cases << run("the order id as digits", ["1", "guid"], seed: attributed(order_with(sale_row(1))))
cases << run("a purchase without a country", [1, "guid"], seed: attributed(order_with(sale_row(1, country: nil))))
cases << run("a purchase with a country Ruby cannot name", [1, "guid"], seed: attributed(order_with(sale_row(1, country: "Atlantis"))))
cases << run("a visit that already has a country", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00", country_code: "FR")] }.merge(order_with(sale_row(1))))
cases << run("a sale that is already attributed", [1, "guid"], seed: attributed(order_with(sale_row(1))).merge(utm_link_driven_sales: [{ id: 1, utm_link_id: 1, utm_link_visit_id: 1, purchase_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }]))
cases << run("only the latest visit of a link counts", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-01 10:00:00"), visit_row(2, 1, "2026-11-03 10:00:00"), visit_row(3, 1, "2026-11-02 10:00:00")] }.merge(order_with(sale_row(1))))
cases << run("two visits at the same second take the newest id", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00"), visit_row(2, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1))))
cases << run("a visit from another browser", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00", guid: "other")] }.merge(order_with(sale_row(1))))
cases << run("a browser guid with a quote", [1, "o'brien"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00", guid: "o'brien")] }.merge(order_with(sale_row(1))))
cases << run("a visit older than the window", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-10-27 23:59:59")] }.merge(order_with(sale_row(1))))
cases << run("a visit at the start of the window", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-10-28 00:00:00")] }.merge(order_with(sale_row(1))))
cases << run("a visit after the purchase", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-04 12:00:01")] }.merge(order_with(sale_row(1))))
cases << run("a visit in the purchase's own second", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, BOUGHT_AT)] }.merge(order_with(sale_row(1))))
cases << run("the newest of two links claims the purchase", [1, "guid"], seed: { utm_links: [link_row(1), link_row(2)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00"), visit_row(2, 2, "2026-11-03 11:00:00")] }.merge(order_with(sale_row(1))))
cases << run("a link of another seller claims nothing", [1, "guid"], seed: { utm_links: [link_row(1, seller_id: 2)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1))))
cases << run("one visit claims the purchases of its seller only", [1, "guid"], seed: attributed(order_with(sale_row(1), sale_row(2, seller: 2, product: 20), sale_row(3, product: 11))))
cases << run("a product page link claims the purchases of its product", [1, "guid"], seed: { utm_links: [link_row(1, target_resource_type: "product_page", target_resource_id: 11)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1), sale_row(2, product: 11), sale_row(3, product: 12))))
cases << run("a product page link for another product", [1, "guid"], seed: { utm_links: [link_row(1, target_resource_type: "product_page", target_resource_id: 99)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1))))
cases << run("a post page link claims every purchase of its seller", [1, "guid"], seed: { utm_links: [link_row(1, target_resource_type: "post_page", target_resource_id: 5)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1), sale_row(2, product: 11))))
cases << run("a revisit between two purchase seconds", [1, "guid"], seed: { utm_links: [link_row(1)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00"), visit_row(2, 1, "2026-11-04 12:00:02")] }.merge(order_with(sale_row(1), sale_row(2, product: 11, at: "2026-11-04 12:00:05"))))
cases << run("a visit that falls between purchases of two links", [1, "guid"], seed: { utm_links: [link_row(1), link_row(2, target_resource_type: "product_page", target_resource_id: 11)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00"), visit_row(2, 2, "2026-11-04 12:00:03")] }.merge(order_with(sale_row(1), sale_row(2, product: 11, at: "2026-11-04 12:00:05"))))
cases << run("a purchase in a country with a code already on the visit nil", [1, "guid"], seed: attributed(order_with(sale_row(1, country: "Brazil"), sale_row(2, country: "Japan", product: 11))))
cases << run("a visit whose link is gone", [1, "guid"], seed: { utm_link_visits: [visit_row(1, 7, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1))))
cases << run("one visit claims purchases of two seconds", [1, "guid"], seed: attributed(order_with(sale_row(1), sale_row(2, product: 11, at: "2026-11-04 12:00:05"))))
cases << run("purchases of one seller in two seconds under a product page link", [1, "guid"], seed: { utm_links: [link_row(1, target_resource_type: "product_page", target_resource_id: 11)], utm_link_visits: [visit_row(1, 1, "2026-11-03 10:00:00")] }.merge(order_with(sale_row(1), sale_row(2, product: 11, at: "2026-11-04 12:00:05"), sale_row(3, product: 11, at: "2026-11-04 12:00:05"))))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
