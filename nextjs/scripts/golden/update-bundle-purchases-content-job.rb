# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-bundle-purchases-content-job.golden.json: UpdateBundlePurchasesContentJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A sale that needs its content updated is what
# Node hands back to Rails (Purchase::UpdateBundlePurchaseContentService creates the product purchases); those cases are recorded up
# to the service call, which a marker exception stands in for. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/update-bundle-purchases-content-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-bundle-purchases-content-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links bundle_products purchases].freeze
IS_BUNDLE = 1 << 25
IS_BUNDLE_PURCHASE = 1 << 25

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase::UpdateBundlePurchaseContentService.prepend(Module.new do
  def perform = raise(HandBackMarker)
end)

def link_row(id, **overrides)
  { id:, name: "Bundle #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: IS_BUNDLE, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def bundle_product_row(id, bundle_id: 1, updated_at: "2026-06-01 00:00:00", **overrides)
  { id:, bundle_id:, product_id: 100 + id, quantity: 1, created_at: SEEDED_AT, updated_at: }.merge(overrides)
end

def sale_row(id, created_at: "2026-03-01 00:00:00", **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: IS_BUNDLE_PURCHASE,
    created_at:, updated_at: created_at }.merge(overrides)
end

def seed(link: link_row(1), **rest) = { links: [link], bundle_products: [bundle_product_row(1)], **rest }

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdateBundlePurchasesContentJob", args:) do
    UpdateBundlePurchasesContentJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a bundle that does not exist", [9], seed)
cases << run("a product that is not a bundle", [1], seed(link: link_row(1, flags: 0)))
cases << run("a bundle id as a digit string", ["1"], seed)
cases << run("a bundle with no bundle product", [1], { links: [link_row(1)] })
cases << run("a bundle whose only bundle product was removed", [1], { links: [link_row(1)], bundle_products: [bundle_product_row(1, deleted_at: "2026-07-01 00:00:00")] })
cases << run("a bundle with no sale", [1], seed)
cases << run("a bundle with a sale bought before its content changed", [1], seed(purchases: [sale_row(1)]))
cases << run("a bundle with a sale bought after its content changed", [1], seed(purchases: [sale_row(1, created_at: "2026-09-01 00:00:00")]))
cases << run("a bundle with a sale bought the second its content changed", [1], seed(purchases: [sale_row(1, created_at: "2026-06-01 00:00:00")]))
cases << run("a bundle with a gift receiver sale", [1], seed(purchases: [sale_row(1, purchase_state: "gift_receiver_purchase_successful")]))
cases << run("a bundle with a gift sender sale", [1], seed(purchases: [sale_row(1, purchase_state: "gift_sender_purchase_successful")]))
cases << run("a bundle with a failed sale", [1], seed(purchases: [sale_row(1, purchase_state: "failed")]))
cases << run("a bundle with a sale that is not a bundle purchase", [1], seed(purchases: [sale_row(1, flags: 0)]))
cases << run("a bundle with a charged back sale", [1], seed(purchases: [sale_row(1, chargeback_date: "2026-04-01 00:00:00")]))
cases << run("a bundle with a fully refunded sale", [1], seed(purchases: [sale_row(1, stripe_refunded: true)]))
cases << run("a bundle with a sale of another product", [1], seed(purchases: [sale_row(1, link_id: 2)]))
cases << run("a bundle with only sales that do not qualify and one that does", [1], seed(purchases: [sale_row(1, flags: 0), sale_row(2, purchase_state: "failed"), sale_row(3)]))
cases << run("a bundle whose latest bundle product change is a deleted one's", [1], {
  links: [link_row(1)],
  bundle_products: [bundle_product_row(1, updated_at: "2026-02-01 00:00:00"), bundle_product_row(2, updated_at: "2026-12-01 00:00:00", deleted_at: "2026-07-01 00:00:00")],
  purchases: [sale_row(1, created_at: "2026-05-01 00:00:00")]
})
cases << run("a bundle id of nil", [nil], seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
