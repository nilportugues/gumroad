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

  def set_cookie_names = Array(response.headers["Set-Cookie"]).join("\n").scan(/^([^=\n]+)=/).flatten

  # The suite's `<model>-test` indices are shared with every other run on this Elasticsearch.
  ES_MODELS = [Link, Purchase, Installment, ConfirmedFollowerEvent, ProductPageView, AudienceMember].freeze

  # Taxonomy pages only route on the discover host (DiscoverDomainConstraint).
  before do
    host! VALID_DISCOVER_REQUEST_HOST
    # The taxonomy is seeded outside the example (`rake taxonomy:seed`). On an empty table every taxonomy path 404s, and
    # DiscoverTaxonomyConstraint memoises the empty list for the whole process.
    raise "Taxonomy table is empty: run `rake taxonomy:seed` in the test database before recording" if Taxonomy.none?
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

      context "with the Black Friday feature on" do
        before { Feature.activate(:offer_codes_search) }

        def make_black_friday_code(product, **attributes)
          create(:offer_code, user: product.user, products: [product], code: SearchProducts::BLACK_FRIDAY_CODE, **attributes)
        end

        def make_black_friday_deals
          products = Link.where(name: ["Rig kit 1", "Rig kit 2", "Rig kit 3", "Rig kit 4", "Rig kit 5"]).order(:name).to_a
          percentage = make_black_friday_code(products[0], amount_cents: nil, amount_percentage: 25)
          make_black_friday_code(products[1], amount_cents: nil, amount_percentage: 0, ownership_duration_tiers: [{ "months" => 0, "amount_percentage" => 10 }, { "months" => 12, "amount_percentage" => 60 }])
          make_black_friday_code(products[2], amount_cents: 100)
          expired = make_black_friday_code(products[3], amount_cents: nil, amount_percentage: 80)
          expired.update_columns(expires_at: 2.days.ago)
          make_black_friday_code(products[4], amount_cents: nil, amount_percentage: 90).update_columns(deleted_at: 1.day.ago)
          [percentage, expired].each_with_index do |offer_code, index|
            build(:purchase, link: offer_code.products.first, offer_code:, price_cents: 400 + (index * 150), purchase_state: "successful").save!(validate: false)
          end
          build(:purchase, link: percentage.products.first, offer_code: percentage, price_cents: 999, purchase_state: "failed").save!(validate: false)
          # A product document reads its sales from the purchases index, which the replay rebuilds from the rows.
          Purchase.import(refresh: true, force: true)
          Link.import(refresh: true, force: true)
        end

        it "renders the root page with the hero and empty stats", parity: true do
          get "/discover"

          expect(response).to be_successful
        end

        it "renders the Black Friday page with the stats of its deals", parity: true do
          make_black_friday_deals

          get "/discover", params: { offer_code: SearchProducts::BLACK_FRIDAY_CODE }

          expect(response).to be_successful
        end

        it "renders the Black Friday page on an Inertia visit", parity: true do
          make_black_friday_deals

          get "/discover", params: { offer_code: SearchProducts::BLACK_FRIDAY_CODE }, headers: inertia_headers

          expect(response).to be_successful
        end
      end

      it "renders the root page and sets the cookie of an affiliate in the query", parity: true do
        affiliate = create(:direct_affiliate, seller: Link.first.user, products: [Link.first])

        get "/discover", params: { affiliate_id: affiliate.external_id_numeric }

        expect(response).to be_successful
        expect(set_cookie_names).to include(affiliate.cookie_key)
      end

      it "sets the cookie of a global affiliate on an autocomplete visit", parity: true do
        affiliate = create(:user).global_affiliate

        get "/discover", params: { a: affiliate.external_id_numeric, query: "rig" }, headers: partial_headers.call("autocomplete_results")

        expect(response).to be_successful
        expect(set_cookie_names).to include(affiliate.cookie_key)
      end

      it "renders the root page for a guest whose cart has a product", parity: true do
        cookies[:_gumroad_guid] = "discover-guid"
        rig = Link.find_by!(name: "Rig kit 1")
        CachedSalesRelatedProductsInfo.create!(product: rig, counts: { Link.find_by!(name: "Short film pack").id.to_s => 4, Link.find_by!(name: "Rig kit 6").id.to_s => 2 })
        create(:cart_product, cart: create(:cart, :guest, browser_guid: "discover-guid"), product: rig)

        get "/discover"

        expect(response).to be_successful
        expect(inertia_props_of(response)["curated_product_ids"]).to eq(Link.where(name: ["Short film pack", "Rig kit 6"]).order(:name).reverse.map(&:external_id))
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

    # Curated products: RecommendedProducts::DiscoverService seeds on the buyer's alive cart products and purchases.
    # Below four seeds every one is used, so the list is a pure function of CachedSalesRelatedProductsInfo.
    context "with curated products" do
      let(:rig) { ->(number) { Link.find_by!(name: "Rig kit #{number}") } }
      let(:film) { Link.find_by!(name: "Short film pack") }
      let(:sample) { Link.find_by!(name: "Free sample") }

      def relate(product, related)
        CachedSalesRelatedProductsInfo.create!(product:, counts: related.transform_keys { _1.id.to_s })
      end

      def buy(product, days_ago:)
        build(:purchase, purchaser: buyer, link: product, purchase_state: "successful").save!(validate: false)
        Purchase.where(link_id: product.id, purchaser_id: buyer.id).update_all(succeeded_at: days_ago.days.ago)
      end

      def add_to_cart(*products)
        cart = buyer.carts.alive.first || create(:cart, user: buyer)
        products.each { create(:cart_product, cart:, product: _1) }
      end

      def curated_ids = (response.media_type == "application/json" ? response.parsed_body["props"] : inertia_props_of(response))["curated_product_ids"]

      it "renders the root page for a buyer with one purchase", parity: true do
        relate(rig[1], rig[6] => 3, rig[7] => 3, film => 5, sample => 1)
        buy(rig[1], days_ago: 3)

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids).to eq([film, rig[7], rig[6], sample].map(&:external_id))
      end

      it "renders the root page on an Inertia visit for a buyer with one cart product", parity: true do
        relate(rig[2], rig[8] => 2, film => 1)
        add_to_cart(rig[2])

        get "/discover", headers: inertia_headers

        expect(response).to be_successful
        expect(curated_ids).to eq([rig[8], film].map(&:external_id))
      end

      it "sums the related counts of a cart product and a purchase", parity: true do
        relate(rig[1], rig[6] => 3, film => 1, rig[2] => 9)
        relate(rig[2], rig[6] => 2, sample => 4, rig[1] => 9)
        add_to_cart(rig[2])
        buy(rig[1], days_ago: 2)

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids).to eq([rig[6], sample, film].map(&:external_id))
      end

      it "renders a category with three seeds and stores the curated sort as a search", parity: true do
        Feature.activate(:store_discover_searches)
        relate(rig[1], rig[6] => 3, rig[7] => 2, film => 1)
        relate(rig[2], rig[9] => 5, sample => 1)
        relate(rig[3], rig[6] => 1, rig[10] => 2)
        add_to_cart(rig[1], rig[2])
        buy(rig[3], days_ago: 1)

        expect { get "/3d/3d-modeling" }.to change(DiscoverSearch, :count).by(1)

        expect(response).to be_successful
      end

      it "drops what the strip cannot show from the curated list", parity: true do
        seller = rig[1].user
        bundle = create(:product, :bundle, user: seller, name: "Rig bundle")
        create(:bundle_product, bundle:, product: rig[5])
        adult = rig[9]
        adult.update_columns(flags: adult.flags | (1 << 15))
        rig[10].update_columns(deleted_at: 1.day.ago)
        rig[11].update_columns(flags: rig[11].flags | (1 << 4))
        rig[12].user.update_columns(name: "Lingerie Maker")
        Link.import(refresh: true, force: true)
        relate(rig[1], rig[5] => 9, rig[9] => 8, rig[10] => 7, rig[11] => 6, rig[12] => 5, film => 4, bundle => 3, rig[3] => 2)
        buy(bundle, days_ago: 1)
        add_to_cart(rig[1])

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids).to eq([film, rig[3]].map(&:external_id))
      end

      it "answers the deferred recommended products with the curated cards", parity: true do
        relate(rig[1], rig[6] => 3, rig[7] => 2, film => 1, sample => 1)
        buy(rig[1], days_ago: 3)

        get "/discover", headers: partial_headers.call("recommended_products")

        expect(response).to be_successful
      end

      it "answers the deferred recommended products of a category with a search", parity: true do
        relate(rig[1], rig[6] => 3, film => 1)
        buy(rig[1], days_ago: 3)

        get "/3d/3d-modeling", headers: partial_headers.call("recommended_products")

        expect(response).to be_successful
      end

      it "answers the deferred recommended wishlists with the curated products", parity: true do
        relate(rig[1], rig[6] => 3, rig[7] => 2, film => 1)
        buy(rig[1], days_ago: 3)
        curated_wishlist = create(:wishlist, user: create(:user, name: "Curator"), name: "Rig picks", recommendable: true)
        create(:wishlist_product, wishlist: curated_wishlist, product: rig[7])
        other = create(:wishlist, user: create(:user, name: "Wish Maker"), name: "Favourites", recommendable: true)
        create(:wishlist_product, wishlist: other, product: sample)
        other.update_columns(recent_follower_count: 10)

        get "/discover", headers: partial_headers.call("recommended_wishlists")

        expect(response).to be_successful
      end

      it "boosts the curated products after the strip in the search", parity: true do
        related = (2..12).index_with { |number| 20 - number }.transform_keys { rig[_1] }
        relate(rig[1], related.merge(film => 8, sample => 7))
        buy(rig[1], days_ago: 3)

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids.size).to eq(13)
      end

      it "answers the deferred recommended products with the first eight of a longer list", parity: true do
        related = (2..12).index_with { |number| 20 - number }.transform_keys { rig[_1] }
        relate(rig[1], related.merge(film => 8, sample => 7))
        buy(rig[1], days_ago: 3)

        get "/discover", headers: partial_headers.call("recommended_products")

        expect(response).to be_successful
      end

      it "answers the deferred recommended wishlists of a category with a curated product in it", parity: true do
        relate(rig[1], rig[6] => 3, film => 2)
        buy(rig[1], days_ago: 3)
        modeling_pick = create(:wishlist, user: create(:user, name: "Modeler"), name: "Modeling picks", recommendable: true)
        create(:wishlist_product, wishlist: modeling_pick, product: rig[6])
        film_pick = create(:wishlist, user: create(:user, name: "Filmmaker"), name: "Film picks", recommendable: true)
        create(:wishlist_product, wishlist: film_pick, product: film)
        uncurated = create(:wishlist, user: create(:user, name: "Rigger"), name: "Rig picks", recommendable: true)
        create(:wishlist_product, wishlist: uncurated, product: rig[3])
        [film_pick, uncurated].each { _1.update_columns(recent_follower_count: 10) }

        get "/3d/3d-modeling", headers: partial_headers.call("recommended_wishlists")

        expect(response).to be_successful
      end

      it "keeps an explicit sort and still curates the nav and the strip", parity: true do
        relate(rig[1], rig[6] => 3, film => 1)
        buy(rig[1], days_ago: 3)

        get "/discover", params: { sort: "newest" }

        expect(response).to be_successful
      end

      it "renders the page when the seeds have no related products", parity: true do
        buy(rig[1], days_ago: 3)

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids).to eq([])
      end

      it "counts a product that is in the cart and was purchased once", parity: true do
        relate(rig[1], rig[6] => 3, film => 1)
        relate(rig[2], rig[7] => 2)
        relate(rig[3], rig[8] => 1)
        add_to_cart(rig[1], rig[2], rig[3])
        buy(rig[1], days_ago: 2)

        get "/discover"

        expect(response).to be_successful
        expect(curated_ids).to eq([rig[6], rig[7], film, rig[8]].map(&:external_id))
      end

      it "hands a buyer with four seeds to Rails", parity: true do
        relate(rig[1], rig[6] => 3, film => 1)
        buy(rig[1], days_ago: 4)
        buy(rig[2], days_ago: 3)
        buy(rig[3], days_ago: 2)
        buy(rig[4], days_ago: 1)

        get "/discover"

        expect(response).to be_successful
      end
    end
  end
end
