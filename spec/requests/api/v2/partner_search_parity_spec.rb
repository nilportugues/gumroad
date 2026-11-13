# frozen_string_literal: true

require "spec_helper"

# GET /v2/partner/products and /v2/partner/creators/top, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-partner-search.replay.test.ts). Both search the products index; the replay rebuilds
# it from the recorded rows. A partner calls with a client-credentials token: no resource owner.
describe "API v2 partner product search", type: :request do
  include Parity::ApiV2Requests

  # A product document reads its sales from the purchases index, so that one is indexed first.
  ES_MODELS = [Purchase, Link].freeze

  let(:partner_application) { create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api") }
  let(:seller) { create(:user, name: "Ada Seller") }
  let(:other_seller) { create(:user, name: "Bo Maker") }
  let!(:partner_seller) { create(:partner_seller, oauth_application: partner_application, user: seller, external_user_id: "ext-1") }
  let!(:other_partner_seller) { create(:partner_seller, oauth_application: partner_application, user: other_seller, external_user_id: "ext-2") }

  # Products are a day apart: the recorder reduces every time near "now" to one token, and ties sort by newest.
  def make_product(user, name, age_in_days:, sales: 0, **attributes)
    create(:product, user:, name:, price_cents: 500, **attributes).tap do |product|
      product.update_columns(created_at: age_in_days.days.ago)
      sales.times { build(:purchase, link: product, purchase_state: "successful", price_cents: 500, fee_cents: 75).save!(validate: false) }
    end
  end

  def index_all
    ES_MODELS.each { _1.import(refresh: true, force: true) }
  end

  def partner_token(application: partner_application, resource_owner_id: nil, scopes: "partner_api", **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id:, scopes:, **attributes)
  end

  def products(api_host: true, **params) = api_call(:get, "/partner/products", token: partner_token, params:, api_host:)

  def top_creators(api_host: true, **params) = api_call(:get, "/partner/creators/top", token: partner_token, params:, api_host:)

  before do
    ES_MODELS.each do |model|
      model.index_name("#{model.name.parameterize}-rt7")
      model.__elasticsearch__.create_index!(force: true)
    end
    Rails.cache.delete("taxonomies_for_nav")
  end

  after { ES_MODELS.each { _1.index_name("#{_1.name.parameterize}-test") } }

  describe "GET /partner/products" do
    let!(:texture_pack) { make_product(seller, "Texture Pack", age_in_days: 3, sales: 2) }
    let!(:brush_set) { make_product(other_seller, "Brush Set", age_in_days: 2, sales: 1, price_cents: 1_500) }
    let!(:icon_kit) { make_product(seller, "Icon Kit", age_in_days: 1) }

    before do
      make_product(seller, "Draft Idea", age_in_days: 4, draft: true, purchase_disabled_at: Time.current)
      make_product(seller, "Old Pack", age_in_days: 5, archived: true)
      make_product(seller, "Banned Pack", age_in_days: 6, banned_at: Time.current)
      make_product(create(:user), "Stranger Pack", age_in_days: 7)
      index_all
    end

    it "lists the live products of the application's creators on the API host", parity: true do
      products

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack", "Brush Set", "Icon Kit"])
      expect(response.parsed_body).to include("success" => true, "total" => 3, "page" => 1, "per_page" => 20, "next_page" => nil)
    end

    it "lists the products on the Gumroad domain", parity: true do
      products(api_host: false)

      expect(response).to have_http_status(:ok)
    end

    it "narrows to one creator by external user id", parity: true do
      products(external_user_id: "ext-2")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Brush Set"])
    end

    it "returns no products for an unknown external user id", parity: true do
      products(external_user_id: "unknown")

      expect(response.parsed_body).to include("products" => [], "total" => 0, "next_page" => nil)
    end

    it "leaves out a creator removed from the program", parity: true do
      other_partner_seller.mark_deleted!

      products

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack", "Icon Kit"])
    end

    it "sorts by newest", parity: true do
      products(sort: "newest")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Icon Kit", "Brush Set", "Texture Pack"])
    end

    it "sorts by hot and new, which keeps only recent products", parity: true do
      texture_pack.update_columns(created_at: 200.days.ago)
      index_all

      products(sort: "hot_and_new")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Brush Set", "Icon Kit"])
    end

    it "sorts by highest rated", parity: true do
      products(sort: "highest_rated")

      expect(response).to have_http_status(:ok)
    end

    it "sorts by most reviewed", parity: true do
      products(sort: "most_reviewed")

      expect(response).to have_http_status(:ok)
    end

    it "paginates", parity: true do
      products(sort: "newest", per_page: 1, page: 2)

      expect(response.parsed_body).to include("total" => 3, "page" => 2, "per_page" => 1, "next_page" => 3)
      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Brush Set"])
    end

    it "ends on the last page", parity: true do
      products(sort: "newest", per_page: 2, page: 2)

      expect(response.parsed_body).to include("page" => 2, "next_page" => nil)
    end

    it "clamps per_page to the maximum", parity: true do
      products(per_page: 1_000)

      expect(response.parsed_body["per_page"]).to eq(100)
    end

    it "clamps per_page and page to their minimum", parity: true do
      products(per_page: 0, page: -3)

      expect(response.parsed_body).to include("per_page" => 1, "page" => 1)
    end

    it "serves the last page inside the search result window", parity: true do
      products(per_page: 100, page: 100)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("products" => [], "next_page" => nil)
    end

    it "rejects a page beyond the search result window", parity: true do
      products(per_page: 100, page: 101)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to start_with("Results are available up to 10000.")
    end

    it "rejects array pagination values", parity: true do
      products(page: ["2"])

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "message" => "page and per_page must be integers.")
    end

    it "rejects hash pagination values", parity: true do
      products(per_page: { size: "1" })

      expect(response).to have_http_status(:bad_request)
    end

    it "filters by a text query", parity: true do
      products(query: "brush")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Brush Set"])
    end

    it "filters by price range", parity: true do
      products(min_price: 10, max_price: 20)

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Brush Set"])
    end

    it "filters by tags", parity: true do
      texture_pack.tag!("textures")
      index_all

      products(tags: "textures")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack"])
    end

    it "filters by a category and its descendants", parity: true do
      category = Discover::TaxonomyPresenter.new.categories_for_api.find { _1[:parent_id].present? }
      icon_kit.update!(taxonomy_id: category[:id])
      index_all

      products(category: category[:path])

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Icon Kit"])
      expect(response.parsed_body["products"].sole["category"]).to eq(category.slice(:id, :path, :label).as_json)
    end

    it "rejects an unknown category", parity: true do
      products(category: "not-a-category")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("Unknown category. Use a path from GET /v2/partner/categories.")
    end

    it "rejects an unsupported sort", parity: true do
      products(sort: "price_asc")

      expect(response).to have_http_status(:bad_request)
    end

    it "leaves out products a seller with profile sections does not show", parity: true do
      create(:seller_profile_products_section, seller:, shown_products: [texture_pack.id])

      products

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack", "Brush Set"])
    end

    it "includes a product a seller features on the profile", parity: true do
      create(:seller_profile_featured_product_section, seller:, featured_product_id: icon_kit.id)

      products(external_user_id: "ext-1")

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Icon Kit"])
    end

    it "does not let another seller's section show a hidden product", parity: true do
      create(:seller_profile_products_section, seller:, shown_products: [texture_pack.id])
      create(:seller_profile_products_section, seller: other_seller, shown_products: [brush_set.id, icon_kit.id])

      products

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack", "Brush Set"])
    end

    it "leaves out a sold-out product its seller hides, and counts it in the total", parity: true do
      make_product(seller, "Sold Out", age_in_days: 0, hide_sold_out_variants: true, max_purchase_count: 0)
      index_all

      products

      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Texture Pack", "Brush Set", "Icon Kit"])
      expect(response.parsed_body["total"]).to eq(4)
    end

    it "continues past an empty page", parity: true do
      make_product(seller, "Sold Out", age_in_days: 0, hide_sold_out_variants: true, max_purchase_count: 0)
      index_all

      products(sort: "newest", per_page: 1)

      expect(response.parsed_body).to include("products" => [], "total" => 4, "next_page" => 2)
    end

    it "renders the card of a pay-what-you-want, a recurring and a free product", parity: true do
      make_product(seller, "Tip Jar", age_in_days: 0, customizable_price: true, price_cents: 0)
      make_product(other_seller, "Club", age_in_days: 0, is_recurring_billing: true, subscription_duration: :monthly)
      index_all

      products(sort: "newest")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["products"].size).to eq(5)
    end

    it "refuses a request without a token", parity: true do
      api_call(:get, "/partner/products")

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token without the partner scope", parity: true do
      api_call(:get, "/partner/products", token: partner_token(scopes: "edit_products"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a token issued for a seller", parity: true do
      api_call(:get, "/partner/products", token: partner_token(resource_owner_id: seller.id))

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body["message"]).to eq("This endpoint is only available to partner applications.")
    end

    it "refuses an application that is not a partner", parity: true do
      partner_application.update!(is_partner: false)

      products

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses an application that is not confidential", parity: true do
      partner_application.update!(confidential: false)

      products

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "GET /partner/creators/top" do
    let!(:texture_pack) { make_product(seller, "Texture Pack", age_in_days: 3, sales: 1) }
    let!(:brush_set) { make_product(other_seller, "Brush Set", age_in_days: 2, sales: 2) }

    before { index_all }

    it "ranks the application's creators by recent sales on the API host", parity: true do
      top_creators

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(%w[ext-2 ext-1])
      expect(response.parsed_body["creators"].first.keys).to eq(%w[external_user_id name avatar_url profile_url])
    end

    it "ranks the creators on the Gumroad domain", parity: true do
      top_creators(api_host: false)

      expect(response).to have_http_status(:ok)
    end

    it "limits the number of creators", parity: true do
      top_creators(limit: 1)

      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(["ext-2"])
    end

    it "clamps the limit to the maximum", parity: true do
      top_creators(limit: 500)

      expect(response.parsed_body["creators"].size).to eq(2)
    end

    it "clamps a limit below one to one", parity: true do
      top_creators(limit: 0)

      expect(response.parsed_body["creators"].size).to eq(1)
    end

    it "applies the hot and new age filter to the ranking", parity: true do
      brush_set.update_columns(created_at: 200.days.ago)
      index_all

      top_creators(sort: "hot_and_new")

      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(["ext-1"])
    end

    it "narrows to one creator by external user id", parity: true do
      top_creators(external_user_id: "ext-1")

      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(["ext-1"])
    end

    it "returns no creators for an unknown external user id", parity: true do
      top_creators(external_user_id: "unknown")

      expect(response.parsed_body).to eq("success" => true, "creators" => [])
    end

    it "leaves out a creator removed from the program", parity: true do
      other_partner_seller.mark_deleted!

      top_creators

      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(["ext-1"])
    end

    it "ranks the creators of a category", parity: true do
      category = Discover::TaxonomyPresenter.new.categories_for_api.find { _1[:parent_id].present? }
      texture_pack.update!(taxonomy_id: category[:id])
      index_all

      top_creators(category: category[:path])

      expect(response.parsed_body["creators"].map { _1["external_user_id"] }).to eq(["ext-1"])
    end

    it "rejects an unknown category", parity: true do
      top_creators(category: "not-a-category")

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects an unsupported sort", parity: true do
      top_creators(sort: "price_asc")

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects an array limit", parity: true do
      top_creators(limit: ["1"])

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "message" => "limit must be an integer.")
    end

    it "refuses a request without a token", parity: true do
      api_call(:get, "/partner/creators/top")

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token issued for a seller", parity: true do
      api_call(:get, "/partner/creators/top", token: partner_token(resource_owner_id: seller.id))

      expect(response).to have_http_status(:forbidden)
    end
  end
end
