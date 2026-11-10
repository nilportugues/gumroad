# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-wishlist-products-job.golden.json: DeleteWishlistProductsJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A wishlist product whose validations depend
# on more than Node reads (a variant, a recurrence, a quantity or rent, a recurring or rentable product) is what Node hands back to
# Rails; those cases are recorded up to the mark_deleted! call a marker exception stands in for. Run it like refund-payout-guard-jobs.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-wishlist-products-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-wishlist-products-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links wishlists wishlist_products].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

# The product is read outside the recording and the query cache, so the statements Rails sends for it stay where its validations put them.
WishlistProduct.prepend(Module.new do
  def mark_deleted!(*)
    logged = RailsRecorder.log
    RailsRecorder.log = nil
    owner = ActiveRecord::Base.uncached { Link.find(product_id) }
    RailsRecorder.log = logged
    hands_back = variant_id || recurrence || quantity != 1 || rent || !owner.buy_only? || owner.is_recurring_billing
    hands_back ? raise(HandBackMarker) : super
  end
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def user_row(id)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def wishlist_row(id, **overrides)
  { id:, user_id: 1, name: "Gadgets", flags: 0, recommendable: true, follower_count: 0, recent_follower_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
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

def deleted_product(wishlists:, wishlist_products:, users: [user_row(1)], **product) = { users:, links: [link_row(1, **DELETED, **product), link_row(2)], wishlists:, wishlist_products: }

cases << run("a deleted product on a wishlist that has nothing else", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("the id as digits", ["1"], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("a deleted product on a wishlist that keeps another product", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1), wishlist_product_row(2, 2)]))
cases << run("a deleted product on a wishlist with a default name", [1], seed: deleted_product(wishlists: [wishlist_row(1, name: "Wishlist 7", recommendable: false)], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("a deleted product on a wishlist opted out of Discover", [1], seed: deleted_product(wishlists: [wishlist_row(1, flags: 1)], wishlist_products: [wishlist_product_row(1, 1), wishlist_product_row(2, 2)]))
cases << run("a deleted product on a wishlist stored as not recommendable that keeps another product", [1], seed: deleted_product(wishlists: [wishlist_row(1, recommendable: false)], wishlist_products: [wishlist_product_row(1, 1), wishlist_product_row(2, 2)]))
cases << run("a deleted product on several wishlists", [1], seed: deleted_product(wishlists: [wishlist_row(1), wishlist_row(2, name: "Tools")], wishlist_products: [wishlist_product_row(1, 1), wishlist_product_row(2, 1, wishlist_id: 2), wishlist_product_row(3, 2, wishlist_id: 2)]))
cases << run("a wishlist product whose wishlist was deleted", [1], seed: deleted_product(wishlists: [wishlist_row(1, **DELETED)], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("a wishlist whose owner is gone", [1], seed: deleted_product(users: [], wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("a wishlist product whose wishlist row is gone", [1], seed: deleted_product(wishlists: [], wishlist_products: [wishlist_product_row(1, 1)]))
cases << run("a wishlist product with a variant", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1, variant_id: 5)]))
cases << run("a wishlist product with a recurrence", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1, recurrence: "monthly")]))
cases << run("a wishlist product with a quantity above one", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1, quantity: 3)]))
cases << run("a wishlist product to rent", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1, rent: true)]))
cases << run("a deleted product that can only be rented", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1)], purchase_type: 1))
cases << run("a deleted recurring product", [1], seed: deleted_product(wishlists: [wishlist_row(1)], wishlist_products: [wishlist_product_row(1, 1)], flags: 2))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
