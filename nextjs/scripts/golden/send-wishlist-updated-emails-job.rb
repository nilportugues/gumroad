# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-wishlist-updated-emails-job.golden.json: SendWishlistUpdatedEmailsJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The mails are deliver_later pushes (visible in the scratch
# Redis) and the sent-email keys and the wishlist's followers_last_contacted_at are database writes. Run it like update-taxonomy-stats-job.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-wishlist-updated-emails-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[wishlists wishlist_products wishlist_followers sent_email_infos users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def wishlist_row(id = 1, **overrides) = { id:, user_id: 1, name: "Reading list", flags: 0, recommendable: 0, follower_count: 0, recent_follower_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def product_row(id, created: "2026-02-01 00:00:00", **overrides) = { id:, wishlist_id: 1, product_id: 100 + id, quantity: 1, rent: 0, created_at: created, updated_at: created }.merge(overrides)

def follower_row(id, created: "2026-01-15 00:00:00", **overrides) = { id:, wishlist_id: 1, follower_user_id: 10 + id, created_at: created, updated_at: created }.merge(overrides)

def digest(follower_id, ids) = SentEmailInfo.mailer_key_digest("CustomerLowPriorityMailer", "wishlist_updated", follower_id, ids)

def sent_key(id, key) = { id:, key:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed)
  $uuid_seq = 0
  seed = { users: [user_row(1)] }.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendWishlistUpdatedEmailsJob", args:) do
    SendWishlistUpdatedEmailsJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

BASE = { wishlists: [wishlist_row] }.freeze
cases = []
cases << run("an unknown wishlist", [99, [1]], {})
cases << run("a wishlist product id that matches nothing", [1, [9]], BASE.merge(wishlist_products: [product_row(1)]))
cases << run("an empty list of ids", [1, []], BASE.merge(wishlist_products: [product_row(1)]))
cases << run("a deleted wishlist product is ignored", [1, [1]], BASE.merge(wishlist_products: [product_row(1, deleted_at: "2026-03-01 00:00:00")], wishlist_followers: [follower_row(1)]))
cases << run("one follower who followed before the product was added", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("a follower who joined after the product was added", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1, created: "2026-03-01 00:00:00")]))
cases << run("a follower who joined at the moment the product was added", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1, created: "2026-02-01 00:00:00")]))
cases << run("a follower who joined a microsecond after the product", [1, [1]], BASE.merge(wishlist_products: [product_row(1, created: "2026-02-01 00:00:00.000001")], wishlist_followers: [follower_row(1, created: "2026-02-01 00:00:00.000002")]))
cases << run("a follower who joined between two products", [1, [1, 2]], BASE.merge(wishlist_products: [product_row(1), product_row(2, created: "2026-04-01 00:00:00")], wishlist_followers: [follower_row(1, created: "2026-03-01 00:00:00")]))
cases << run("two followers get their own counts", [1, [1, 2]], BASE.merge(wishlist_products: [product_row(1), product_row(2, created: "2026-04-01 00:00:00")], wishlist_followers: [follower_row(1), follower_row(2, created: "2026-03-01 00:00:00")]))
cases << run("a follower already sent this update", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1), follower_row(2)], sent_email_infos: [sent_key(1, digest(1, [1]))]))
cases << run("a sent key for a different list of products does not count", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)], sent_email_infos: [sent_key(1, digest(1, [1, 2]))]))
cases << run("a deleted follower is mailed too", [1, [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1, deleted_at: "2026-03-01 00:00:00")]))
cases << run("a newer product than the batch ends the run", [1, [1]], BASE.merge(wishlist_products: [product_row(1), product_row(2, created: "2026-04-01 00:00:00")], wishlist_followers: [follower_row(1)]))
cases << run("a newer product that is deleted does not", [1, [1]], BASE.merge(wishlist_products: [product_row(1), product_row(2, created: "2026-04-01 00:00:00", deleted_at: "2026-05-01 00:00:00")], wishlist_followers: [follower_row(1)]))
cases << run("products older than the last contact are not newer", [1, [2]], BASE.merge(wishlists: [wishlist_row(followers_last_contacted_at: "2026-03-01 00:00:00")], wishlist_products: [product_row(1), product_row(2, created: "2026-03-01 00:00:00")], wishlist_followers: [follower_row(1)]))
cases << run("a product added after the last contact is newer", [1, [1]], BASE.merge(wishlists: [wishlist_row(followers_last_contacted_at: "2026-01-20 00:00:00")], wishlist_products: [product_row(1), product_row(2, created: "2026-04-01 00:00:00")], wishlist_followers: [follower_row(1)]))
cases << run("a wishlist with no followers", [1, [1]], BASE.merge(wishlist_products: [product_row(1)]))
cases << run("a discoverable wishlist stays recommendable", [1, [1]], BASE.merge(wishlists: [wishlist_row(recommendable: 1)], wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("a wishlist with a default name", [1, [1]], BASE.merge(wishlists: [wishlist_row(name: "Wishlist 3", recommendable: 1)], wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("a wishlist with a blank name fails to save", [1, [1]], BASE.merge(wishlists: [wishlist_row(name: "")], wishlist_products: [product_row(1)]))
cases << run("a wishlist whose owner is gone fails to save", [1, [1]], BASE.merge(wishlists: [wishlist_row(user_id: 77)], wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("product ids given as strings", [1, %w[1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("the wishlist id given as a string", ["1", [1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))
cases << run("duplicate product ids", [1, [1, 1]], BASE.merge(wishlist_products: [product_row(1)], wishlist_followers: [follower_row(1)]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
