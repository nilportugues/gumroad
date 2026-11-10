# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-wishlist-products-job.golden.json: DeleteWishlistProductsJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The first WishlistProduct#mark_deleted!
# is what Node hands back to Rails; those cases are recorded up to the call a marker exception stands in for. Run it like
# refund-payout-guard-jobs.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-wishlist-products-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-wishlist-products-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links wishlists wishlist_products].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

WishlistProduct.prepend(Module.new do
  def mark_deleted!(*) = raise(HandBackMarker)
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def wishlist_product_row(id, product_id, **overrides)
  { id:, wishlist_id: 1, product_id:, quantity: 1, rent: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

def run(name, args, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteWishlistProductsJob", args:) do
    DeleteWishlistProductsJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("the product does not exist", [99])
cases << run("a product whose deletion was undone", [1], seed: { links: [link_row(1)], wishlist_products: [wishlist_product_row(1, 1)] })
cases << run("a deleted product nobody wishlisted", [1], seed: { links: [link_row(1, **DELETED)] })
cases << run("a deleted product whose wishlist products are already deleted", [1], seed: { links: [link_row(1, **DELETED)], wishlist_products: [wishlist_product_row(1, 1, **DELETED)] })
cases << run("a deleted product only another product is wishlisted", [1], seed: { links: [link_row(1, **DELETED), link_row(2)], wishlist_products: [wishlist_product_row(1, 2)] })
cases << run("a deleted product with a wishlist product to delete", [1], seed: { links: [link_row(1, **DELETED)], wishlist_products: [wishlist_product_row(1, 1)] })
cases << run("the id as digits", ["1"], seed: { links: [link_row(1, **DELETED)], wishlist_products: [wishlist_product_row(1, 1)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
