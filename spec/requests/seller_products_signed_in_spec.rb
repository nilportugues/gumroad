# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the seller's products pages (Products/Index and Products/Archived/Index), recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-products.replay.test.ts, which sends
# the last request of each example. The tables are deferred props, so the examples that record them send the
# partial reload the client sends after the page loads.
describe "Seller products pages when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Products Seller") }
  let(:tables_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "X-Inertia-Partial-Component" => component,
      "X-Inertia-Partial-Data" => "products_data,memberships_data" }
  end
  let(:component) { "Products/Index" }

  def cache_values(*products)
    products.each { |product| ProductCachedValue.create!(product:) }
  end

  def tables(path, params = {})
    get path, params:, headers: tables_headers
  end

  context "when the seller has products" do
    let!(:one_time) { create(:product, user: seller, name: "Zine", price_cents: 500, created_at: Time.utc(2025, 1, 1)) }
    let!(:pay_what_you_want) { create(:product, user: seller, name: "Art pack", price_cents: 1250, customizable_price: true, created_at: Time.utc(2025, 2, 1)) }
    let!(:draft) { create(:product, user: seller, name: "Draft idea", price_cents: 99, draft: true, created_at: Time.utc(2025, 3, 1)) }
    let!(:membership) { create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 4, 1)) }
    let!(:preorder) { create(:product, user: seller, name: "Coming soon", price_cents: 2000, is_in_preorder_state: true, created_at: Time.utc(2025, 5, 1)) }

    before { cache_values(one_time, pay_what_you_want, draft, membership, preorder) }

    it "renders the page with the tables deferred", parity: true do
      log_in(seller)

      get products_path

      expect(response).to be_successful
      page = inertia_page_of(response)
      expect(page["deferredProps"]).to eq("data" => %w[products_data memberships_data])
      expect(page["props"]).not_to include("products_data")
    end

    it "renders the page at /links, the path of the resource", parity: true do
      log_in(seller)

      get "/links"

      expect(response).to be_successful
      expect(inertia_page_of(response)).to include("component" => "Products/Index", "url" => "/links")
    end

    it "lists the products and memberships at /links", parity: true do
      log_in(seller)

      tables "/links", query: "art"

      expect(response.parsed_body["props"]["products_data"]["products"].map { _1["name"] }).to eq(["Art pack"])
    end

    it "lists the products and memberships newest first", parity: true do
      log_in(seller)

      tables products_path

      expect(response).to be_successful
      expect(response.parsed_body["props"]["products_data"]["products"].map { _1["name"] }).to eq(["Coming soon", "Draft idea", "Art pack", "Zine"])
      expect(response.parsed_body["props"]["memberships_data"]["memberships"].map { _1["name"] }).to eq(["Club"])
    end

    it "sorts by name descending", parity: true do
      log_in(seller)

      tables products_path, products_sort_key: "name", products_sort_direction: "desc"

      expect(response.parsed_body["props"]["products_data"]["products"].map { _1["name"] }).to eq(["Zine", "Draft idea", "Coming soon", "Art pack"])
      expect(response.parsed_body["props"]["products_data"]["sort"]).to eq("key" => "name", "direction" => "desc")
    end

    it "sorts by status", parity: true do
      log_in(seller)

      tables products_path, products_sort_key: "status", products_sort_direction: "asc"

      expect(response).to be_successful
    end

    it "sorts by successful sales count and by revenue", parity: true do
      log_in(seller)

      tables products_path, products_sort_key: "successful_sales_count", products_sort_direction: "desc", memberships_sort_key: "revenue", memberships_sort_direction: "asc"

      expect(response).to be_successful
    end

    it "searches product names", parity: true do
      log_in(seller)

      tables products_path, query: "art"

      expect(response.parsed_body["props"]["products_data"]["products"].map { _1["name"] }).to eq(["Art pack"])
      expect(response.parsed_body["props"]["memberships_data"]["memberships"]).to eq([])
    end

    it "answers a page past the last page with the last page", parity: true do
      log_in(seller)

      tables products_path, products_page: "9", memberships_page: "-3"

      expect(response.parsed_body["props"]["products_data"]["pagination"]).to eq("pages" => 1, "page" => 1)
    end

    it "sends a sort Elasticsearch performs to the app" do
      log_in(seller)

      tables products_path, products_sort_key: "display_price_cents", products_sort_direction: "asc"

      expect(response).to be_successful
    end

    it "includes the archived count and the piracy tab flag in the first render", parity: true do
      create(:product, user: seller, name: "Old", archived: true)
      log_in(seller)

      get products_path

      expect(inertia_props_of(response)).to include("archived_products_count" => 1, "has_products" => true, "can_create_product" => true)
    end
  end

  it "quotes products listed in other currencies in their own", parity: true do
    products = { "eur" => 1050, "jpy" => 1500, "gbp" => 99 }.each_with_index.map do |(currency, cents), i|
      create(:product, user: seller, name: currency.upcase, created_at: Time.utc(2025, 1, i + 1)).tap do |product|
        product.update_columns(price_currency_type: currency, price_cents: cents)
        product.prices.update_all(currency:, price_cents: cents)
      end
    end
    cache_values(*products)
    log_in(seller)

    tables products_path

    expect(response.parsed_body["props"]["products_data"]["products"].map { _1["price_formatted"] }).to eq(["£0.99", "¥1,500", "€10.50"])
  end

  it "renders the empty state for a seller without products", parity: true do
    log_in(seller)

    get products_path

    expect(inertia_props_of(response)).to include("has_products" => false, "archived_products_count" => 0)
  end

  it "answers the tables of a seller without products", parity: true do
    log_in(seller)

    tables products_path

    expect(response.parsed_body["props"]["products_data"]).to include("products" => [], "pagination" => { "pages" => 1, "page" => 1 })
  end

  it "pages through more than one page of products", parity: true do
    products = Array.new(51) { |index| create(:product, user: seller, name: "Product #{format('%02d', index)}", created_at: Time.utc(2025, 1, 1) + index.days) }
    cache_values(*products)
    log_in(seller)

    tables products_path, products_page: "2"

    expect(response.parsed_body["props"]["products_data"]["products"].size).to eq(1)
    expect(response.parsed_body["props"]["products_data"]["pagination"]).to eq("pages" => 2, "page" => 2)
  end

  it "leaves a product without a cached value to the app" do
    create(:product, user: seller, name: "Uncached")
    log_in(seller)

    tables products_path

    expect(response).to be_successful
  end

  it "shows other sellers' products to nobody", parity: true do
    other = create(:product, user: create(:user), name: "Not mine")
    cache_values(other)
    log_in(seller)

    tables products_path

    expect(response.parsed_body["props"]["products_data"]["products"]).to eq([])
  end

  describe "team members" do
    let!(:product) { create(:product, user: seller, name: "Team product") }

    before { cache_values(product) }

    %w[admin marketing accountant support].each do |role|
      it "shows a #{role} the products with their permissions", parity: true do
        member = create(:user, name: "Team #{role}")
        membership = create(:team_membership, user: member, seller:, role:)
        log_in(member)
        switch_to(membership)

        tables products_path

        expect(response).to be_successful
        expect(response.parsed_body["props"]["products_data"]["products"].size).to eq(1)
      end
    end
  end

  describe "archived products" do
    let(:component) { "Products/Archived/Index" }

    it "sends a seller with nothing archived back to the products page", parity: true do
      log_in(seller)

      get products_archived_index_path

      expect(response).to redirect_to(products_url)
    end

    it "lists archived products", parity: true do
      archived = create(:product, user: seller, name: "Retired", archived: true, purchase_disabled_at: Time.utc(2025, 1, 1))
      create(:product, user: seller, name: "Live")
      cache_values(archived)
      log_in(seller)

      tables products_archived_index_path

      expect(response).to be_successful
      expect(response.parsed_body["props"]["products_data"]["products"].map { _1["name"] }).to eq(["Retired"])
    end

    it "stays on the tab when a search matches nothing", parity: true do
      cache_values(create(:product, user: seller, name: "Retired", archived: true))
      log_in(seller)

      get products_archived_index_path, params: { query: "zzz" }

      expect(response).to be_successful
    end

    it "renders the first response with the tables deferred", parity: true do
      cache_values(create(:product, user: seller, name: "Retired", archived: true))
      log_in(seller)

      get products_archived_index_path

      expect(inertia_page_of(response)["deferredProps"]).to eq("data" => %w[products_data memberships_data])
    end
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get products_path

    expect(response).to redirect_to(login_path(next: "/products"))
  end
end
