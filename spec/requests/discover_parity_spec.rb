# frozen_string_literal: true

require "spec_helper"

# Discover (DiscoverController#index) signed out and signed in, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/discover.replay.test.ts, which sends the last
# request of each example. The replay rebuilds the `products` index from the recorded rows.
describe "Discover", type: :request do
  include Parity::SignedInDashboard

  let(:inertia_headers) { { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" } }
  let(:partial_headers) { ->(data) { inertia_headers.merge("X-Inertia-Partial-Component" => "Discover/Index", "X-Inertia-Partial-Data" => data) } }
  let(:three_d) { Taxonomy.find_by_path(%w[3d]) }
  let(:modeling) { Taxonomy.find_by_path(%w[3d 3d-modeling]) }
  let(:films) { Taxonomy.find_by(slug: "films") }

  # Search breaks ties by newest, and the recorder reduces every time near "now" to one token: space the
  # products a day apart so their order survives into the fixture.
  def make_product(name, seller, taxonomy, price_cents: 500, tags: [], age_in_days: 1, **attributes)
    # The factory's review purchase would charge a card at any other price.
    create(:product, :recommendable, name:, user: seller, taxonomy:, price_cents: 0, **attributes).tap do |product|
      product.update_columns(price_cents:, created_at: age_in_days.days.ago)
      tags.each { product.tag!(_1) }
    end
  end

  # The nav sorts by recent sales, then slug; a tie between two taxonomies sharing a slug is left to Ruby's sort,
  # which orders it differently on each platform, so give every taxonomy its own count.
  def make_taxonomy_stats
    now = Time.current
    TaxonomyStat.insert_all(Taxonomy.pluck(:id).map { |id| { taxonomy_id: id, recent_sales_count: id, created_at: now, updated_at: now } })
  end

  def make_catalogue
    allow_any_instance_of(Link).to receive(:update_asset_preview)
    sellers = [create(:recommendable_user, name: "Mara Maker"), create(:recommendable_user, name: "Theo Tools")]
    12.times do |i|
      make_product("Rig kit #{i + 1}", sellers[i % 2], modeling, price_cents: 300 + (i * 100), tags: i.even? ? %w[rigging blender] : %w[blender], age_in_days: i + 3)
    end
    make_product("Short film pack", sellers[0], films, price_cents: 2500, tags: %w[film], age_in_days: 20)
    make_product("Free sample", sellers[1], three_d, price_cents: 0, tags: %w[sample], age_in_days: 21)
    Link.import(refresh: true, force: true)
  end

  # The suite's `<model>-test` indices are shared with every other run on this Elasticsearch.
  ES_MODELS = [Link, Purchase, Installment, ConfirmedFollowerEvent, ProductPageView, AudienceMember].freeze

  # Taxonomy pages only route on the discover host (DiscoverDomainConstraint).
  before do
    host! VALID_DISCOVER_REQUEST_HOST
    make_taxonomy_stats
    ES_MODELS.each do |model|
      model.index_name("#{model.name.parameterize}-ws83")
      model.__elasticsearch__.create_index!(force: true)
    end
  end

  after { ES_MODELS.each { _1.index_name("#{_1.name.parameterize}-test") } }

  context "when signed out" do
    it "renders an empty Discover page", parity: true do
      get "/discover"

      expect(response).to be_successful
    end

    context "with products" do
      before { make_catalogue }

      it "renders the root page on the app domain", parity: true do
        host! DOMAIN

        get "/discover"

        expect(response).to be_successful
      end

      it "renders the root page", parity: true do
        get "/discover"

        expect(response).to be_successful
      end

      it "answers an Inertia visit", parity: true do
        get "/discover", headers: inertia_headers

        expect(response).to be_successful
      end

      it "renders a category", parity: true do
        get "/3d"

        expect(response).to be_successful
      end

      it "renders a subcategory", parity: true do
        get "/3d/3d-modeling"

        expect(response).to be_successful
      end

      it "renders the second page of a category", parity: true do
        get "/3d/3d-modeling", params: { from: 9 }

        expect(response).to be_successful
      end

      it "renders a category with a sort and a price range", parity: true do
        get "/3d/3d-modeling", params: { sort: "price_asc", min_price: 5, max_price: 11 }

        expect(response).to be_successful
      end

      it "renders a search and stores it", parity: true do
        Feature.activate(:store_discover_searches)
        cookies[:_gumroad_guid] = "discover-guid"

        expect { get "/discover", params: { query: "rig kit" } }.to change(DiscoverSearch, :count).by(1)

        expect(response).to be_successful
      end

      it "renders a search within a category", parity: true do
        Feature.activate(:store_discover_searches)
        cookies[:_gumroad_guid] = "discover-guid"

        get "/3d/3d-modeling", params: { query: "rig" }

        expect(response).to be_successful
      end

      it "filters by tags", parity: true do
        get "/discover", params: { tags: "blender" }

        expect(response).to be_successful
      end

      it "filters by a tag within a category", parity: true do
        get "/3d/3d-modeling", params: { tags: "rigging,blender", sort: "newest" }

        expect(response).to be_successful
      end

      it "filters by rating and file type", parity: true do
        get "/discover", params: { rating: 4, filetypes: "pdf" }

        expect(response).to be_successful
      end

      it "renders the Black Friday page without the feature", parity: true do
        get "/discover", params: { offer_code: SearchProducts::BLACK_FRIDAY_CODE }

        expect(response).to be_successful
      end

      it "answers the deferred recommended wishlists", parity: true do
        wishlist = create(:wishlist, user: create(:user, name: "Wish Maker"), name: "Favourites", recommendable: true)
        create(:wishlist_product, wishlist:, product: Link.first)

        get "/discover", headers: partial_headers.call("recommended_wishlists")

        expect(response).to be_successful
      end

      it "answers the deferred recommended products for a category", parity: true do
        get "/3d/3d-modeling", headers: partial_headers.call("recommended_products")

        expect(response).to be_successful
      end

      it "answers an autocomplete visit", parity: true do
        get "/discover", params: { query: "rig" }, headers: partial_headers.call("autocomplete_results")

        expect(response).to be_successful
      end

      it "answers an autocomplete visit and stores the search", parity: true do
        Feature.activate(:store_discover_searches)
        cookies[:_gumroad_guid] = "discover-guid"

        expect { get "/discover", params: { query: "Rig kit" }, headers: partial_headers.call("autocomplete_results") }.to change(DiscoverSearch, :count).by(1)

        expect(response).to be_successful
      end

      it "answers an autocomplete visit with the visitor's recent searches", parity: true do
        cookies[:_gumroad_guid] = "discover-guid"
        ["rig kit", "rigging", "film"].each do |query|
          search = DiscoverSearch.create!(query:, browser_guid: "discover-guid")
          search.create_discover_search_suggestion!
        end

        get "/discover", params: { query: "rig" }, headers: partial_headers.call("autocomplete_results")

        expect(response).to be_successful
      end

      it "answers an autocomplete visit without a query for a visitor with no history", parity: true do
        get "/discover", headers: partial_headers.call("autocomplete_results")

        expect(response).to be_successful
      end

      it "answers an autocomplete visit without a query for a visitor who viewed products", parity: true do
        cookies[:_gumroad_guid] = "discover-guid"
        add_page_view(Link.find_by!(name: "Rig kit 2"), 1.day.ago.iso8601, browser_guid: "discover-guid")
        add_page_view(Link.find_by!(name: "Short film pack"), 2.days.ago.iso8601, browser_guid: "discover-guid")
        ProductPageView.__elasticsearch__.refresh_index!

        get "/discover", headers: partial_headers.call("autocomplete_results")

        expect(response).to be_successful
      end

      it "answers the deferred recommended wishlists for a category", parity: true do
        modeling_wishlist = create(:wishlist, user: create(:user, name: "Modeler"), name: "Modeling picks", recommendable: true)
        create(:wishlist_product, wishlist: modeling_wishlist, product: Link.find_by!(name: "Rig kit 1"))
        film_wishlist = create(:wishlist, user: create(:user, name: "Filmmaker"), name: "Film picks", recommendable: true)
        create(:wishlist_product, wishlist: film_wishlist, product: Link.find_by!(name: "Short film pack"))

        get "/3d/3d-modeling", headers: partial_headers.call("recommended_wishlists")

        expect(response).to be_successful
      end

      it "answers the deferred recently viewed row when the flag is on", parity: true do
        Feature.activate(:discover_recently_viewed)
        cookies[:_gumroad_guid] = "discover-guid"
        add_page_view(Link.find_by!(name: "Rig kit 2"), 1.day.ago.iso8601, browser_guid: "discover-guid")
        add_page_view(Link.find_by!(name: "Rig kit 3"), 2.days.ago.iso8601, browser_guid: "discover-guid")
        ProductPageView.__elasticsearch__.refresh_index!

        get "/discover", headers: partial_headers.call("recently_viewed")

        expect(response).to be_successful
      ensure
        Feature.deactivate(:discover_recently_viewed)
      end
    end
  end

  context "when signed in" do
    let(:buyer) { create(:user, name: "Discover Buyer") }

    before do
      make_catalogue
      log_in(buyer)
    end

    it "renders the root page", parity: true do
      get "/discover"

      expect(response).to be_successful
      expect(inertia_props_of(response)["logged_in_user"]).to include("email" => buyer.email)
    end

    it "renders a category", parity: true do
      get "/3d/3d-modeling"

      expect(response).to be_successful
    end

    it "renders a search and stores it for the user", parity: true do
      Feature.activate(:store_discover_searches)

      expect { get "/discover", params: { query: "rig kit" } }.to change(DiscoverSearch, :count).by(1)

      expect(response).to be_successful
    end

    it "answers an autocomplete visit with the buyer's history", parity: true do
      Feature.activate(:store_discover_searches)
      search = DiscoverSearch.create!(query: "rig kit", user: buyer)
      search.create_discover_search_suggestion!
      add_page_view(Link.find_by!(name: "Rig kit 2"), 1.day.ago.iso8601, user_id: buyer.id)
      ProductPageView.__elasticsearch__.refresh_index!

      get "/discover", headers: partial_headers.call("autocomplete_results")

      expect(response).to be_successful
    end

    it "answers the deferred recently viewed row when the flag is on", parity: true do
      Feature.activate(:discover_recently_viewed)
      add_page_view(Link.find_by!(name: "Rig kit 2"), 1.day.ago.iso8601, user_id: buyer.id)
      ProductPageView.__elasticsearch__.refresh_index!

      get "/discover", headers: partial_headers.call("recently_viewed")

      expect(response).to be_successful
    ensure
      Feature.deactivate(:discover_recently_viewed)
    end

    it "renders the page for a buyer who has purchased", parity: true do
      create(:purchase, purchaser: buyer, link: Link.first)

      get "/discover"

      expect(response).to be_successful
    end

    it "answers the deferred recommended wishlists", parity: true do
      wishlist = create(:wishlist, user: create(:user, name: "Wish Maker"), name: "Favourites", recommendable: true)
      create(:wishlist_product, wishlist:, product: Link.first)

      get "/discover", headers: partial_headers.call("recommended_wishlists")

      expect(response).to be_successful
    end
  end
end
