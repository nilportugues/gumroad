# frozen_string_literal: true

# Produces nextjs/src/server/services/__fixtures__/pages-profile-data.golden.json: the `gumroad-data` payload of Pages::ProfileData.build
# (as pages are served with it: to_json, then ERB::Util.json_escape) for sellers set up in a scratch database, each case rolled back.
# The Node port (services/pages-profile-data.ts) builds the payload for a seller with no published post and no reputation summary; the
# product's formatted price and URL are read by the loader (and proved by the request recordings), so a case records them as Ruby wrote
# them next to the stored description, the one field the builder derives. A seller with a post or the flag, or a description with a control
# character, is handed back.
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

def scenario(name, tabs: nil, products: [], deleted_products: 0, draft_products: 0, archived_products: 0, posts: 0, unpublished_posts: 0, feature: false, hands_back: false)
  result = nil
  hands_back ||= posts.positive? || feature
  ActiveRecord::Base.transaction do
    seller = FactoryBot.create(:user, name: "Golden Seller", username: "goldenseller")
    seed_profile(seller, tabs)
    created = products.each_with_index.map do |description, i|
      product = Link.bypass_product_creation_limit { FactoryBot.create(:product, user: seller, name: "Product #{i}", description: nil) }
      product.update_columns(description:)
      product
    end
    deleted_products.times { |i| FactoryBot.create(:product, user: seller, name: "Deleted #{i}").update_columns(deleted_at: Time.current) }
    draft_products.times { |i| FactoryBot.create(:product, user: seller, name: "Draft #{i}").update_columns(draft: true) }
    archived_products.times { |i| FactoryBot.create(:product, user: seller, name: "Archived #{i}").update_attribute(:archived, true) }
    posts.times { |i| FactoryBot.create(:audience_installment, seller:, name: "Post #{i}", published_at: Time.utc(2026, 1, 2, 3, 4, 5), shown_on_profile: true) }
    unpublished_posts.times { |i| FactoryBot.create(:audience_installment, seller:, name: "Unpublished #{i}", published_at: nil) }
    Feature.activate_user(:seller_reputation_summary, seller) if feature
    result = {
      "name" => name,
      "tabs" => tabs,
      "descriptions" => products,
      "deleted_products" => deleted_products,
      "draft_products" => draft_products,
      "archived_products" => archived_products,
      "posts" => posts,
      "unpublished_posts" => unpublished_posts,
      "reputation_summary_enabled" => feature,
      "hands_back" => hands_back,
      "json" => hands_back ? nil : record(seller),
      # What the loader reads for each listed product, in the payload's order: the fields Ruby derives that the builder does not.
      "listed" => hands_back ? nil : Pages::ProfileData.products(seller).zip(created.reverse.first(Pages::ProfileData::MAX_ITEMS)).map { |entry, product| { "name" => entry[:name], "url" => entry[:url], "price" => entry[:price], "native_type" => entry[:native_type], "description" => product.reload.description } },
      "products_total" => hands_back ? nil : Pages::ProfileData.products_total(seller),
    }
    raise ActiveRecord::Rollback
  end
  Rails.cache.clear
  result
end

cases = TAB_NAME_SETS.map { |name, tabs| scenario(name, tabs:) }
LONG = "word " * 60
cases << scenario("a deleted product only", deleted_products: 1)
cases << scenario("an unpublished post only", unpublished_posts: 1)
cases << scenario("a product", products: ["A plain description"])
cases << scenario("a product without a description", products: [nil])
cases << scenario("a blank description", products: ["  \n\t "])
cases << scenario("two products, the newest first", products: %w[first second])
cases << scenario("whitespace is squished", products: ["  two   spaces\nand\r\nlines\t\ttabs \u00a0nbsp\u3000ideographic  "])
cases << scenario("a description of exactly the limit", products: ["x" * 200])
cases << scenario("a description one past the limit", products: ["x" * 201])
cases << scenario("a long description of words", products: [LONG])
cases << scenario("a truncation that ends on a space", products: ["#{'x' * 196} yyyy"])
cases << scenario("astral characters across the limit", products: ["😀" * 250])
cases << scenario("quotes and punctuation survive", products: ["He said \"hi\" — it's 100% fine; a/b \\ c"])
cases << scenario("unicode text", products: ["日本語 café ünïcode"])
cases << scenario("a draft, an archived and a deleted product beside a live one", products: ["live"], draft_products: 1, archived_products: 1, deleted_products: 1)
cases << scenario("a draft product only", draft_products: 1)
cases << scenario("an archived product only", archived_products: 1)
cases << scenario("a description with markup", products: ["<b>bold</b> text"])
cases << scenario("a description with an ampersand", products: ["Tom & Jerry"])
cases << scenario("a description with an entity", products: ["a &amp; b"])
cases << scenario("a description of paragraphs and a list", products: ["<p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul><p>a<br>b</p>"])
cases << scenario("a description with a script and a style", products: ["<script>alert(1)</script><style>p { color: red }</style>kept"])
cases << scenario("a description with comparison signs", products: ["1 < 2 > 0 &lt; &gt; &quot;q&quot; &#39;s&#39; &#65; &nbsp;|&copy; &unknown; &amp"])
cases << scenario("a description with an unclosed tag and a stray close", products: ["<p>unclosed <b>bold</i> </p>stray</div>"])
cases << scenario("markup across the limit", products: ["<p>#{'x &amp; ' * 120}</p>"])
cases << scenario("a description with a control character", products: ["a\u0001b"], hands_back: true)
cases << scenario("more products than the payload lists", products: Array.new(101) { |i| "Described #{i}" })
cases << scenario("a published post", posts: 1)
cases << scenario("a product and a published post", products: ["x"], posts: 1)
cases << scenario("the reputation summary on", feature: true)

File.write(OUT, JSON.pretty_generate("cases" => cases) + "\n")
puts "wrote #{cases.size} cases to #{OUT}"
