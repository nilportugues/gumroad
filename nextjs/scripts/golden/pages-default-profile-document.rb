# frozen_string_literal: true

# Produces nextjs/src/server/services/__fixtures__/pages-default-profile-document.golden.json: Pages::DefaultProfileDocument.render for sellers set
# up in a scratch database, each case rolled back. The Node port (services/pages-default-profile-document.ts) renders the storefront of a
# seller with no product, no published post and no uploaded avatar, and hands every other seller back, so the cases that list something
# record only that they hand back (their documents carry random subdomains).
#   docker exec <ruby container> bash -c 'cd /app && bundle exec rails runner nextjs/scripts/golden/pages-default-profile-document.rb'
require "json"
require "factory_bot_rails"
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
EsCapture.body = %({"count":0})

FactoryBot.definition_file_paths = [Rails.root.join("spec/support/factories").to_s]
FactoryBot.find_definitions
Rails.logger = ActiveSupport::Logger.new(nil)

OUT = Rails.root.join("nextjs/src/server/services/__fixtures__/pages-default-profile-document.golden.json")

def scenario(name, user: {}, colors: nil, products: 0, posts: 0, hands_back: false)
  result = nil
  ActiveRecord::Base.transaction do
    seller = FactoryBot.create(:user, **user)
    seller.update_columns(**user.slice(:name, :bio, :username))
    SellerProfile.new(seller:, **colors).save!(validate: false) unless colors.nil?
    products.times { |i| FactoryBot.create(:product, user: seller, name: "Product #{i}") }
    posts.times { |i| FactoryBot.create(:audience_installment, seller:, name: "Post #{i}", published_at: Time.utc(2026, 1, 2, 3, 4, 5), shown_on_profile: true) }
    seller.reload
    result = {
      "name" => name,
      "seller" => { "name" => seller.name, "username" => seller.username, "external_id" => seller.external_id, "bio" => seller.bio },
      "profile" => colors && colors.transform_keys(&:to_s),
      "products" => products,
      "posts" => posts,
      "hands_back" => hands_back,
      "document" => hands_back ? nil : Pages::DefaultProfileDocument.render(seller),
    }
    raise ActiveRecord::Rollback
  end
  Rails.cache.clear
  result
end

cases = [
  scenario("a named seller with no profile row", user: { name: "Golden Seller", bio: "I make things." }),
  scenario("no name falls back to the username", user: { name: nil, username: "goldenuser", bio: nil }),
  scenario("a blank name falls back to the username", user: { name: "   ", username: "goldenuser", bio: "" }),
  scenario("a whitespace-only bio is left out", user: { name: "Golden Seller", bio: " \t\n" }),
  scenario("markup in the name and bio is escaped", user: { name: %(<b>"Tom" & 'Jerry'</b>), bio: %(a > b && c < d "quoted" it's <script>alert(1)</script>) }),
  scenario("unicode and line breaks in the bio", user: { name: "日本語 café 😀", bio: "line one\nline two sep" }),
  scenario("seller colours that are plain hex", user: { name: "Golden Seller" }, colors: { background_color: "#123456", highlight_color: "#ff0000" }),
  scenario("seller colours in upper case", user: { name: "Golden Seller" }, colors: { background_color: "#ABCDEF", highlight_color: "#00FF7F" }),
  scenario("colours that are not a strict hex fall back", user: { name: "Golden Seller" }, colors: { background_color: "red", highlight_color: "#fff" }),
  scenario("a colour with a trailing newline falls back", user: { name: "Golden Seller" }, colors: { background_color: "#123456\n", highlight_color: "#ff0000\n" }),
  scenario("a colour that closes the style block falls back", user: { name: "Golden Seller" }, colors: { background_color: "#12345</style>", highlight_color: "#ff0000;}" }),
  scenario("a profile row with no colours", user: { name: "Golden Seller" }, colors: { background_color: nil, highlight_color: nil }),
  scenario("empty colours", user: { name: "Golden Seller" }, colors: { background_color: "", highlight_color: "" }),
  scenario("a white accent", user: { name: "Golden Seller" }, colors: { background_color: "#000000", highlight_color: "#ffffff" }),
  scenario("a black accent", user: { name: "Golden Seller" }, colors: { background_color: "#ffffff", highlight_color: "#000000" }),
  scenario("a saturated yellow accent", user: { name: "Golden Seller" }, colors: { background_color: "#ffffff", highlight_color: "#ffff00" }),
  scenario("a product", user: { name: "Golden Seller" }, products: 1, hands_back: true),
  scenario("a published post", user: { name: "Golden Seller" }, posts: 1, hands_back: true),
]

File.write(OUT, JSON.pretty_generate("cases" => cases) + "\n")
puts "wrote #{cases.size} cases to #{OUT}"
