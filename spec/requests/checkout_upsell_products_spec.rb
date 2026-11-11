# frozen_string_literal: true

require "spec_helper"

# Checkout::Upsells::ProductsController (GET /checkout/upsells/products and /products/:id), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws20u.replay.test.ts, which sends the last request of each example. A product
# with an uploaded thumbnail goes through Active Storage variants, so that example records what Node hands back.
describe "Checkout upsell products", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller) }
  let(:accept_json) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  def make_product(name, **attributes)
    create(:product, { user: seller, name:, price_cents: 1500, created_at: Time.utc(2025, 1, 1) }.merge(attributes))
  end

  def products_json = response.parsed_body

  # The factory's PNG cannot be written into a fixture; any attached file sends Node back to Rails.
  def attach_text_thumbnail(product)
    thumbnail = Thumbnail.new(product:)
    thumbnail.file.attach(io: StringIO.new("not an image"), filename: "thumbnail.txt", content_type: "text/plain")
    thumbnail.save!(validate: false)
  end

  describe "index" do
    it "answers an empty list to a visitor without a seller", parity: true do
      make_product("Unseen")

      get checkout_upsells_products_path, headers: accept_json

      expect(response).to have_http_status(:ok)
      expect(products_json).to eq([])
    end

    context "when signed in as the seller" do
      before { log_in(seller) }

      it "lists eligible products newest first", parity: true do
        make_product("Older", created_at: Time.utc(2025, 1, 1))
        make_product("Newer", created_at: Time.utc(2025, 3, 1))

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.map { _1["name"] }).to eq(%w[Newer Older])
      end

      it "leaves out archived, deleted and membership products and other sellers' products", parity: true do
        make_product("Mine")
        make_product("Archived", archived: true)
        make_product("Gone", deleted_at: Time.utc(2025, 2, 2))
        create(:membership_product, user: seller, name: "Tiers")
        create(:product, name: "Theirs")

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.map { _1["name"] }).to eq(["Mine"])
      end

      it "lists a product with its versions as options", parity: true do
        product = create(:product_with_digital_versions, user: seller, name: "Versioned", price_cents: 700)
        product.alive_variants.first.update!(price_difference_cents: 300, max_purchase_count: 5, description: "First version")

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.first["options"].map { _1["name"] }).to eq(["Untitled 1", "Untitled 2"])
      end

      it "lists the review count and average rating", parity: true do
        product = make_product("Reviewed")
        create(:product_review_stat, link: product, reviews_count: 3, average_rating: 4.5, ratings_of_four_count: 1, ratings_of_five_count: 2)

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.first).to include("review_count" => 3, "average_rating" => 4.5)
      end

      it "lists a product priced in another currency", parity: true do
        make_product("Euro product", price_currency_type: "eur", price_cents: 900)

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.first).to include("currency_code" => "eur", "price_cents" => 900)
      end

      it "lists a product whose thumbnail is an unsplash image", parity: true do
        product = make_product("Pictured")
        Thumbnail.new(product:, unsplash_url: "https://images.example.com/photo.png").save!(validate: false)

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.first["thumbnail_url"]).to eq("https://images.example.com/photo.png")
      end

      it "hands a product with an uploaded thumbnail to Rails", parity: true do
        attach_text_thumbnail(make_product("Pictured"))

        get checkout_upsells_products_path, headers: accept_json

        expect(response).to have_http_status(:ok)
      end

      it "caps the list at 25 products", parity: true do
        26.times { |i| make_product("Product #{i}", created_at: Time.utc(2025, 1, 1) + i.days) }

        get checkout_upsells_products_path, headers: accept_json

        expect(products_json.size).to eq(25)
        expect(products_json.first["name"]).to eq("Product 25")
      end

      it "searches by name", parity: true do
        make_product("Summer pack")
        make_product("Winter pack")

        get checkout_upsells_products_path(query: "summer"), headers: accept_json

        expect(products_json.map { _1["name"] }).to eq(["Summer pack"])
      end

      it "searches by version name", parity: true do
        product = create(:product_with_digital_versions, user: seller, name: "Versioned")
        product.alive_variants.second.update!(name: "Deluxe edition")
        make_product("Other")

        get checkout_upsells_products_path(query: "deluxe"), headers: accept_json

        expect(products_json.map { _1["name"] }).to eq(["Versioned"])
      end

      it "ignores a deleted version in the search", parity: true do
        product = create(:product_with_digital_versions, user: seller, name: "Versioned")
        product.alive_variants.second.update!(name: "Deluxe edition", deleted_at: Time.utc(2025, 2, 2))

        get checkout_upsells_products_path(query: "deluxe"), headers: accept_json

        expect(products_json).to eq([])
      end

      it "treats percent and underscore in the search as plain characters", parity: true do
        make_product("100% cotton")
        make_product("1000 cotton")

        get checkout_upsells_products_path(query: "100%"), headers: accept_json

        expect(products_json.map { _1["name"] }).to eq(["100% cotton"])
      end

      it "lists every product for a blank search", parity: true do
        make_product("One")

        get checkout_upsells_products_path(query: "  "), headers: accept_json

        expect(products_json.size).to eq(1)
      end
    end

    it "lists the products of the seller whose subdomain it is asked on", parity: true do
      make_product("Storefront product")
      host! seller.subdomain

      get checkout_upsells_products_path, headers: accept_json

      expect(products_json.map { _1["name"] }).to eq(["Storefront product"])
    end
  end

  describe "show" do
    it "answers the props of a product to a visitor", parity: true do
      product = make_product("Public", native_type: "ebook")

      get checkout_upsells_product_path(product.external_id), headers: accept_json

      expect(products_json).to include("id" => product.external_id, "permalink" => product.unique_permalink, "name" => "Public", "native_type" => "ebook", "price_cents" => 1500, "currency_code" => "usd")
    end

    it "answers the props of another seller's product", parity: true do
      product = create(:product, name: "Theirs")
      log_in(seller)

      get checkout_upsells_product_path(product.external_id), headers: accept_json

      expect(products_json["name"]).to eq("Theirs")
    end

    it "answers a product's versions as options", parity: true do
      product = create(:product_with_digital_versions, user: seller, name: "Versioned")

      get checkout_upsells_product_path(product.external_id), headers: accept_json

      expect(products_json["options"].size).to eq(2)
    end

    it "answers not found for an archived product", parity: true do
      get checkout_upsells_product_path(make_product("Archived", archived: true).external_id), headers: accept_json

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted product", parity: true do
      get checkout_upsells_product_path(make_product("Gone", deleted_at: Time.utc(2025, 2, 2)).external_id), headers: accept_json

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a membership", parity: true do
      get checkout_upsells_product_path(create(:membership_product, user: seller).external_id), headers: accept_json

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for an unknown id", parity: true do
      get checkout_upsells_product_path("unknown"), headers: accept_json

      expect(response).to have_http_status(:not_found)
    end

    it "hands a product with an uploaded thumbnail to Rails", parity: true do
      product = make_product("Pictured")
      attach_text_thumbnail(product)

      get checkout_upsells_product_path(product.external_id), headers: accept_json

      expect(response).to have_http_status(:ok)
    end
  end
end
