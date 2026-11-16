# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-cached-sales-related-products-infos-job.golden.json:
# UpdateCachedSalesRelatedProductsInfosJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/update-cached-sales-related-products-infos-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-cached-sales-related-products-infos-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links sales_related_products_infos cached_sales_related_products_infos].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def pair_row(id, smaller, larger, sales_count, **overrides)
  { id:, smaller_product_id: smaller, larger_product_id: larger, sales_count:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def cache_row(id, product_id, counts, **overrides)
  { id:, product_id:, counts: counts&.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def links(*ids) = ids.map { link_row(_1) }

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdateCachedSalesRelatedProductsInfosJob", args:) do
    UpdateCachedSalesRelatedProductsInfosJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

many = (2..505).to_a
cases = []
cases << run("the product does not exist", [99])
cases << run("a product with no related products and no cache row", [1], seed: { links: links(1) })
cases << run("a product with no related products and an empty cache row", [1], seed: { links: links(1), cached_sales_related_products_infos: [cache_row(1, 1, {})] })
cases << run("a product with no related products and a stale cache row", [1], seed: { links: links(1, 2), cached_sales_related_products_infos: [cache_row(1, 1, { "2" => 4 })] })
cases << run("a product with no related products and a cache row without counts", [1], seed: { links: links(1), cached_sales_related_products_infos: [cache_row(1, 1, nil)] })
cases << run("a smaller product with related larger products", [1], seed: { links: links(1, 2, 3), sales_related_products_infos: [pair_row(1, 1, 2, 3), pair_row(2, 1, 3, 7)] })
cases << run("a larger product with related smaller products", [5], seed: { links: links(1, 2, 5), sales_related_products_infos: [pair_row(1, 1, 5, 2), pair_row(2, 2, 5, 9)] })
cases << run("a product related on both sides", [3], seed: { links: links(1, 3, 6), sales_related_products_infos: [pair_row(1, 1, 3, 4), pair_row(2, 3, 6, 11)] })
cases << run("pairs with equal sales counts", [1], seed: { links: links(1, 2, 3, 4), sales_related_products_infos: [pair_row(1, 1, 2, 5), pair_row(2, 1, 3, 5), pair_row(3, 1, 4, 5)] })
cases << run("pairs of other products are ignored", [1], seed: { links: links(1, 2, 3, 4), sales_related_products_infos: [pair_row(1, 1, 2, 1), pair_row(2, 3, 4, 50)] })
cases << run("a pair whose sales count is zero", [1], seed: { links: links(1, 2), sales_related_products_infos: [pair_row(1, 1, 2, 0)] })
cases << run("a pair whose sales count is negative", [1], seed: { links: links(1, 2), sales_related_products_infos: [pair_row(1, 1, 2, -1)] })
cases << run("counts already cached", [1], seed: { links: links(1, 2, 3), sales_related_products_infos: [pair_row(1, 1, 2, 3), pair_row(2, 1, 3, 7)], cached_sales_related_products_infos: [cache_row(1, 1, { "3" => 7, "2" => 3 })] })
cases << run("counts cached in another key order", [1], seed: { links: links(1, 2, 3), sales_related_products_infos: [pair_row(1, 1, 2, 3), pair_row(2, 1, 3, 7)], cached_sales_related_products_infos: [cache_row(1, 1, { "2" => 3, "3" => 7 })] })
cases << run("counts that changed since they were cached", [1], seed: { links: links(1, 2, 3), sales_related_products_infos: [pair_row(1, 1, 2, 3), pair_row(2, 1, 3, 8)], cached_sales_related_products_infos: [cache_row(1, 1, { "3" => 7, "2" => 3 })] })
cases << run("a cache row with a product that is no longer related", [1], seed: { links: links(1, 2, 9), sales_related_products_infos: [pair_row(1, 1, 2, 3)], cached_sales_related_products_infos: [cache_row(1, 1, { "9" => 4, "2" => 3 })] })
cases << run("a cache row of another product is left alone", [1], seed: { links: links(1, 2), sales_related_products_infos: [pair_row(1, 1, 2, 3)], cached_sales_related_products_infos: [cache_row(1, 2, { "1" => 3 })] })
cases << run("more related products than the limit keeps the best sellers", [1], seed: { links: links(1, *many), sales_related_products_infos: many.map { |id| pair_row(id, 1, id, (id % 7) + (id == 505 ? 100 : 0)) } })
cases << run("a soft-deleted product", [1], seed: { links: [link_row(1, deleted_at: "2026-02-01 00:00:00")] })
cases << run("a deleted related product is still counted", [1], seed: { links: [link_row(1), link_row(2, deleted_at: "2026-02-01 00:00:00")], sales_related_products_infos: [pair_row(1, 1, 2, 3)] })
cases << run("the id as digits", ["1"], seed: { links: links(1, 2), sales_related_products_infos: [pair_row(1, 1, 2, 3)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
