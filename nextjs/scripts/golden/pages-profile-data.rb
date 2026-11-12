# frozen_string_literal: true

# Produces nextjs/src/server/services/__fixtures__/pages-profile-data.golden.json: the `gumroad-data` payload of Pages::ProfileData.build
# (as pages are served with it: to_json, then ERB::Util.json_escape) for sellers set up in a scratch database, each case rolled back.
# The Node port (services/pages-profile-data.ts) builds the payload only for a seller with no product and no published post and hands
# every other seller back, so the cases that hold products or posts record Ruby's answer as the reason to hand back.
#   docker exec gr-ruby-c25m bash -c 'source /tmp/env25.sh; cd /app && bundle exec rails runner nextjs/scripts/golden/pages-profile-data.rb'
require "json"
require "factory_bot_rails"
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
EsCapture.body = %({"count":0})

FactoryBot.definition_file_paths = [Rails.root.join("spec/support/factories").to_s]
FactoryBot.find_definitions
Rails.logger = ActiveSupport::Logger.new(nil)

OUT = Rails.root.join("nextjs/src/server/services/__fixtures__/pages-profile-data.golden.json")

TAB_NAME_SETS = {
  "no profile row" => nil,
  "an empty tab list" => [],
  "plain tabs" => %w[Home About],
  "markup and punctuation in tab names" => ["Q&A", "<b>bold</b>", "a > b", "</script><script>alert(1)</script>", "say \"hi\"", "back\\slash", "it's"],
  "unicode tab names" => ["日本語", "café", "😀", "line sep", "para sep", "tab\there", "nl\nhere", "ctl\u0001x", "del\u007fx", "nbsp x"],
  "blank tab names are skipped" => ["", " ", "\t", " ", "kept", "​"],
  "a very long tab name" => ["x" * 600],
}.freeze

def sections(names) = names.map { |name| { "name" => name, "sections" => [] } }

def record(seller)
  json = Pages::ProfileData.build(seller).to_json
  ERB::Util.json_escape(json)
end

def seed_profile(seller, names)
  return if names.nil?

  profile = SellerProfile.new(seller:, json_data: { "tabs" => sections(names) })
  profile.save!(validate: false)
end

def scenario(name, tabs: nil, products: 0, deleted_products: 0, draft_products: 0, archived_products: 0, posts: 0, unpublished_posts: 0, feature: false)
  result = nil
  hands_back = [products, draft_products, archived_products, posts].any?(&:positive?) || feature
  ActiveRecord::Base.transaction do
    seller = FactoryBot.create(:user, name: "Golden Seller")
    seed_profile(seller, tabs)
    products.times { |i| FactoryBot.create(:product, user: seller, name: "Product #{i}") }
    deleted_products.times { |i| FactoryBot.create(:product, user: seller, name: "Deleted #{i}").update_columns(deleted_at: Time.current) }
    draft_products.times { |i| FactoryBot.create(:product, user: seller, name: "Draft #{i}").update_columns(draft: true) }
    archived_products.times { |i| FactoryBot.create(:product, user: seller, name: "Archived #{i}").update_attribute(:archived, true) }
    posts.times { |i| FactoryBot.create(:audience_installment, seller:, name: "Post #{i}", published_at: Time.utc(2026, 1, 2, 3, 4, 5), shown_on_profile: true) }
    unpublished_posts.times { |i| FactoryBot.create(:audience_installment, seller:, name: "Unpublished #{i}", published_at: nil) }
    Feature.activate_user(:seller_reputation_summary, seller) if feature
    result = {
      "name" => name,
      "tabs" => tabs,
      "products" => products,
      "deleted_products" => deleted_products,
      "draft_products" => draft_products,
      "archived_products" => archived_products,
      "posts" => posts,
      "unpublished_posts" => unpublished_posts,
      "reputation_summary_enabled" => feature,
      # Whatever holds a product, a post or the flag is Rails': its payload carries random subdomains, so only the shape that is served is kept.
      "hands_back" => hands_back,
      "json" => hands_back ? nil : record(seller),
    }
    raise ActiveRecord::Rollback
  end
  Rails.cache.clear
  result
end

cases = TAB_NAME_SETS.map { |name, tabs| scenario(name, tabs:) }
cases << scenario("a deleted product only", deleted_products: 1)
cases << scenario("an unpublished post only", unpublished_posts: 1)
cases << scenario("a product", products: 1)
cases << scenario("a draft product", draft_products: 1)
cases << scenario("an archived product", archived_products: 1)
cases << scenario("a published post", posts: 1)
cases << scenario("the reputation summary on", feature: true)

File.write(OUT, JSON.pretty_generate("cases" => cases) + "\n")
puts "wrote #{cases.size} cases to #{OUT}"
