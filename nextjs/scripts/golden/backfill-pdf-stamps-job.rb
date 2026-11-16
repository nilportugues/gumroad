# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/backfill-pdf-stamps-job.golden.json: BackfillPdfStampsJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). StampPdfForPurchaseJob.perform_inline downloads, stamps and uploads a
# PDF, so it is replaced by a marker that ends the case with `hands_back`: the statements before it are the reads Node repeats.
# Run it like retry-stripe-jp-address-resyncs-job.rb (USE_DB_WORKER_REPLICAS=true, env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/backfill-pdf-stamps-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links purchases url_redirects].freeze
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
GIFT_RECEIVER_PURCHASE = 1 << 5
GIFT_SENDER_PURCHASE = 1 << 6

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end

StampPdfForPurchaseJob.singleton_class.prepend(Module.new do
  def perform_inline(*) = raise(HandBackMarker)
end)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, link_id: 1, **overrides)
  { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def redirect_row(id, purchase_id, **overrides) = { id:, purchase_id:, link_id: 1, token: "token#{id}", flags: 0, uses: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, links: [link_row(1)], purchases: [], redirects: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { links:, purchases:, url_redirects: redirects }, sidekiq: true, job: "BackfillPdfStampsJob", args:) do
    BackfillPdfStampsJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

def many(count, first = 1, **overrides) = (first...(first + count)).map { purchase_row(_1, **overrides) }

cases = []
cases << run("a product that does not exist", [9])
cases << run("a product with no sales", [1])
cases << run("a product id given as digits", ["1"], purchases: many(2))
cases << run("a sale with no download page", [1], purchases: many(1))
cases << run("a sale with a download page", [1], purchases: many(1), redirects: [redirect_row(1, 1)])
cases << run("two sales, the second with a download page", [1], purchases: many(2), redirects: [redirect_row(1, 2)])
cases << run("sales of another product", [1], purchases: many(2, link_id: 2), links: [link_row(1), link_row(2)])
cases << run("a sale that failed", [1], purchases: [purchase_row(1, purchase_state: "failed")], redirects: [redirect_row(1, 1)])
cases << run("a sale that is a gift receiver success", [1], purchases: [purchase_row(1, purchase_state: "gift_receiver_purchase_successful")], redirects: [redirect_row(1, 1)])
cases << run("a sale that is a gift sender", [1], purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE)], redirects: [redirect_row(1, 1)])
cases << run("a sale that is a gift receiver", [1], purchases: [purchase_row(1, flags: GIFT_RECEIVER_PURCHASE)], redirects: [redirect_row(1, 1)])
cases << run("a recurring charge", [1], purchases: [purchase_row(1, subscription_id: 5)], redirects: [redirect_row(1, 1)])
cases << run("an original subscription purchase", [1], purchases: [purchase_row(1, subscription_id: 5, flags: ORIGINAL_SUBSCRIPTION_PURCHASE)], redirects: [redirect_row(1, 1)])
cases << run("a gift receiver subscription charge", [1], purchases: [purchase_row(1, subscription_id: 5, flags: GIFT_RECEIVER_PURCHASE)], redirects: [redirect_row(1, 1)])
cases << run("49 sales with no download page", [1], purchases: many(49))
cases << run("50 sales with no download page", [1], purchases: many(50))
cases << run("51 sales with no download page", [1], purchases: many(51))
cases << run("50 sales, the oldest with a download page", [1], purchases: many(50), redirects: [redirect_row(1, 1)])
cases << run("a page of sales after a purchase id", [1, 30], purchases: many(60))
cases << run("a last page of sales after a purchase id", [1, 11], purchases: many(60))
cases << run("a purchase id of zero", [1, 0], purchases: many(3))
cases << run("a purchase id of nil", [1, nil], purchases: many(3))
cases << run("a purchase id given as digits", [1, "30"], purchases: many(60))
cases << run("sales with ids far apart", [1], purchases: many(2) + many(2, 4_000_000_000))
cases << run("two sales sharing a download page owner", [1], purchases: many(2), redirects: [redirect_row(1, 1), redirect_row(2, 1)])
cases << run("a download page of another sale", [1], purchases: many(2), redirects: [redirect_row(1, 3)])

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
