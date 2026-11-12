# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/sitemap-generation.golden.json: the runs of SitemapService that win the generation
# lock, driven through the real workers as Sidekiq jobs (support/sidekiq_executor.rb). The service is forced to the production
# path (upload_sitemap_to_s3? and ping_search_engines? true) with fake uploader credentials, and every outbound request is answered
# by WebMock (capture_http!), so the S3 PUT, the DELETE of an emptied sitemap and the search engine ping are recorded as requests.
# The gzip carries the wall clock in its header, so the upload body is recorded inflated. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/sitemap-generation.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
require "zlib"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/sitemap-generation.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users wishlists wishlist_products].freeze
KEPT_HEADERS = %w[Cache-Control Content-Type X-Amz-Acl].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ENV["S3_SITEMAP_UPLOADER_ACCESS_KEY"] = "AKIAEXAMPLEUPLOADER"
ENV["S3_SITEMAP_UPLOADER_SECRET_ACCESS_KEY"] = "example-uploader-secret"

SitemapService.prepend(Module.new do
  private

  def upload_sitemap_to_s3? = true
  def ping_search_engines? = true
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user_#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def wishlist_row(id, user_id: 1, **overrides)
  { id:, user_id:, name: "Gadgets #{id}", flags: 0, recommendable: true, follower_count: 0, recent_follower_count: 0,
    created_at: SEEDED_AT, updated_at: "2026-02-03 04:05:06" }.merge(overrides)
end

def product_rows(wishlist_id, count, first_id: 1, **overrides)
  count.times.map do |i|
    { id: (wishlist_id * 100_000) + first_id + i, wishlist_id:, product_id: first_id + i, quantity: 1, rent: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
  end
end

def run(name, job, args, seed)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job:, args:, http_responses: Array.new(3) { { status: 200, body: "" } }) do
    job.constantize.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result.delete("http_responses")
  result["http"] = result["http"].map do |request|
    body = request["body"].to_s
    uploaded = request["method"] == "PUT" ? Zlib::GzipReader.new(StringIO.new(body)).read : nil
    { "method" => request["method"], "url" => request["url"], "headers" => request["headers"].slice(*KEPT_HEADERS), "inflated_body" => uploaded }
  end
  result
end

def wishlists(name, seed) = run(name, "RefreshWishlistSitemapDailyWorker", [], seed)

cases = []
cases << wishlists("no wishlist at all", {})
cases << wishlists("one wishlist with three products", { users: [user_row(1)], wishlists: [wishlist_row(1)], wishlist_products: product_rows(1, 3) })
cases << wishlists("a wishlist with only two products", { users: [user_row(1)], wishlists: [wishlist_row(1)], wishlist_products: product_rows(1, 2) })
cases << wishlists("a wishlist with three rows for two products", {
  users: [user_row(1)], wishlists: [wishlist_row(1)],
  wishlist_products: product_rows(1, 2) + product_rows(1, 1, first_id: 1).map { _1.merge(id: 999, variant_id: 5, recurrence: "monthly") }
})
cases << wishlists("a wishlist whose third product was removed", {
  users: [user_row(1)], wishlists: [wishlist_row(1)],
  wishlist_products: product_rows(1, 2) + product_rows(1, 1, first_id: 3).map { _1.merge(deleted_at: "2026-03-01 00:00:00") }
})
cases << wishlists("a wishlist that is not recommendable", { users: [user_row(1)], wishlists: [wishlist_row(1, recommendable: false)], wishlist_products: product_rows(1, 3) })
cases << wishlists("a deleted wishlist", { users: [user_row(1)], wishlists: [wishlist_row(1, deleted_at: "2026-03-01 00:00:00")], wishlist_products: product_rows(1, 3) })
cases << wishlists("a wishlist with a name that needs punctuation stripped", {
  users: [user_row(1)], wishlists: [wishlist_row(1, name: "  Rock & Roll -- Essentials!! ")], wishlist_products: product_rows(1, 3)
})
cases << wishlists("a wishlist with a name that needs transliteration", {
  users: [user_row(1)], wishlists: [wishlist_row(1, name: "Café ünïcode")], wishlist_products: product_rows(1, 3)
})
cases << wishlists("a wishlist whose name is markup", {
  users: [user_row(1)], wishlists: [wishlist_row(1, name: "<b>Tom</b> & Jerry")], wishlist_products: product_rows(1, 3)
})
cases << wishlists("wishlists of several sellers", {
  users: [user_row(1), user_row(2, username: nil), user_row(3, username: "Seller.Three")],
  wishlists: [wishlist_row(1), wishlist_row(2, user_id: 2), wishlist_row(3, user_id: 3, updated_at: "2026-11-04 12:30:45.5"), wishlist_row(4, user_id: 1)],
  wishlist_products: product_rows(1, 3) + product_rows(2, 4) + product_rows(3, 3) + product_rows(4, 3)
})
cases << wishlists("a wishlist with the same name as another", {
  users: [user_row(1)], wishlists: [wishlist_row(1, name: "Same"), wishlist_row(2, name: "Same")], wishlist_products: product_rows(1, 3) + product_rows(2, 3)
})
cases << wishlists("a wishlist whose seller does not exist", { wishlists: [wishlist_row(1)], wishlist_products: product_rows(1, 3) })
big = (1..1001).map { |id| wishlist_row(id, user_id: 1 + (id % 2), name: "List") }
cases << wishlists("a thousand and one wishlists", {
  users: [user_row(1), user_row(2)], wishlists: big, wishlist_products: big.flat_map { product_rows(_1[:id], 3) }
})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
