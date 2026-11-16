# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/regenerate-sales-related-products-infos-job.golden.json:
# RegenerateSalesRelatedProductsInfosJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like purge-old-deleted-asset-previews-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/regenerate-sales-related-products-infos-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links purchases sales_related_products_infos].freeze
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]
IS_GIFT_RECEIVER_PURCHASE = Purchase.flag_mapping["flags"][:is_gift_receiver_purchase]

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, link_id, email, **overrides)
  { id:, link_id:, seller_id: 1, email:, purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def info_row(id, smaller, larger, count = 5) = { id:, smaller_product_id: smaller, larger_product_id: larger, sales_count: count, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, links: [1, 2, 3, 4], purchases: [], infos: [])
  result = capture(name, now: NOW, tables: TABLES, seed: { links: links.map { link_row(_1) }, purchases:, sales_related_products_infos: infos }, sidekiq: true,
                         job: "RegenerateSalesRelatedProductsInfosJob", args:) do
    RegenerateSalesRelatedProductsInfosJob.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

# Buyer a@ owns products 1, 2 and 3; b@ owns 1 and 2; c@ owns 1 and 4.
BASE = [
  purchase_row(1, 1, "a@example.com"), purchase_row(2, 2, "a@example.com"), purchase_row(3, 3, "a@example.com"),
  purchase_row(4, 1, "b@example.com"), purchase_row(5, 2, "b@example.com"),
  purchase_row(6, 1, "c@example.com"), purchase_row(7, 4, "c@example.com"),
].freeze

cases = []
cases << run("a product that does not exist", [9])
cases << run("a product nobody bought", [1])
cases << run("buyers who own other products", [1], purchases: BASE)
cases << run("a product bought by one buyer only", [4], purchases: BASE)
cases << run("existing pairs of the product are replaced and others kept", [1], purchases: BASE, infos: [info_row(1, 1, 2), info_row(2, 1, 4), info_row(3, 2, 3), info_row(4, 3, 4)])
cases << run("the product as the larger side of a pair", [3], purchases: BASE, infos: [info_row(1, 1, 3), info_row(2, 2, 3)])
cases << run("an email limit", [1, 2], purchases: BASE)
cases << run("an email limit of zero", [1, 0], purchases: BASE)
cases << run("a relationships limit", [1, 5000, 1], purchases: BASE)
cases << run("a relationships limit of zero", [1, 5000, 0], purchases: BASE, infos: [info_row(1, 1, 2)])
cases << run("an insert batch size of one", [1, 5000, 1000, 1], purchases: BASE)
cases << run("an insert batch size of two", [1, 5000, 1000, 2], purchases: BASE)
cases << run("an insert batch size of zero", [1, 5000, 1000, 0], purchases: BASE)
cases << run("a negative insert batch size", [1, 5000, 1000, -1], purchases: BASE)
cases << run("a negative insert batch size and nothing to insert", [1, 5000, 1000, -1])
cases << run("a negative email limit", [1, -1], purchases: BASE)
cases << run("purchase states", [1], purchases: [
  purchase_row(1, 1, "a@example.com"),
  purchase_row(2, 2, "a@example.com", purchase_state: "preorder_authorization_successful"),
  purchase_row(3, 3, "a@example.com", purchase_state: "gift_receiver_purchase_successful"),
  purchase_row(4, 4, "a@example.com", purchase_state: "failed"),
  purchase_row(5, 2, "b@example.com", purchase_state: "in_progress"),
  purchase_row(6, 1, "b@example.com", purchase_state: "failed"),
])
cases << run("refunded and charged back purchases", [1], purchases: [
  purchase_row(1, 1, "a@example.com"),
  purchase_row(2, 2, "a@example.com", stripe_refunded: true),
  purchase_row(3, 3, "a@example.com", stripe_refunded: false),
  purchase_row(4, 4, "a@example.com", chargeback_date: "2026-02-01 00:00:00"),
  purchase_row(5, 2, "a@example.com", chargeback_date: "2026-02-01 00:00:00", flags: CHARGEBACK_REVERSED),
  purchase_row(6, 1, "b@example.com", stripe_refunded: true),
  purchase_row(7, 2, "b@example.com"),
])
cases << run("gift receiver purchases", [1], purchases: [
  purchase_row(1, 1, "a@example.com"),
  purchase_row(2, 2, "a@example.com", flags: IS_GIFT_RECEIVER_PURCHASE),
  purchase_row(3, 3, "a@example.com"),
])
cases << run("purchases without an email", [1], purchases: [
  purchase_row(1, 1, nil), purchase_row(2, 2, nil), purchase_row(3, 1, "a@example.com"), purchase_row(4, 2, "a@example.com"),
])
cases << run("the same buyer twice for one product", [1], purchases: [
  purchase_row(1, 1, "a@example.com"), purchase_row(2, 1, "a@example.com"), purchase_row(3, 2, "a@example.com"), purchase_row(4, 2, "a@example.com"),
])
cases << run("emails differing in case", [1], purchases: [
  purchase_row(1, 1, "A@example.com"), purchase_row(2, 2, "a@example.com"), purchase_row(3, 2, "B@example.com"), purchase_row(4, 1, "b@example.com"),
])
cases << run("a product bought by many buyers ranks by customer count", [1], purchases:
  (1..5).flat_map { |i| [purchase_row(i, 1, "b#{i}@example.com")] } +
  [purchase_row(10, 2, "b1@example.com"), purchase_row(11, 2, "b2@example.com"), purchase_row(12, 2, "b3@example.com"), purchase_row(13, 3, "b1@example.com"), purchase_row(14, 4, "b1@example.com"), purchase_row(15, 4, "b2@example.com")])
cases << run("1001 existing pairs take two delete batches", [1], links: (1..3).to_a, purchases: BASE, infos: (2..1002).map { info_row(_1, 1, _1 + 10) })
cases << run("exactly 1000 existing pairs take a second empty select", [1], purchases: BASE, infos: (2..1001).map { info_row(_1, 1, _1 + 10) })
cases << run("a product id given as a string", ["1"], purchases: BASE)
cases << run("a product id given as a float", [1.0], purchases: BASE)
cases << run("a missing product id", [])
cases << run("an email limit given as null", [1, nil], purchases: BASE)
cases << run("an email limit given as a string", [1, "2"], purchases: BASE)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
