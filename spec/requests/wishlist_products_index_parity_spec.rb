# frozen_string_literal: true

require "spec_helper"

# GET /wishlists/:wishlist_id/products (Wishlists::ProductsController#index, WishlistPresenter#public_items), the page of cards a
# wishlist's "load more" fetches on the owner's subdomain. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/wishlist-products-index.replay.test.ts. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Wishlists::ProductsController#index", type: :request do
  include Parity::AudienceSignedIn

  let(:owner) { create(:user, name: "Wishlist Owner", username: "wishowner") }
  let(:buyer) { create(:user, name: "Wishing Buyer") }
  let(:wishlist) { create(:wishlist, user: owner, name: "Reading list") }
  let(:json_headers) { { "Accept" => "application/json" } }

  # `page` is always sent, as the wishlist page does: with none, `pagy` reads a `params` the presenter does not have (500).
  before { host! DOMAIN }

  def fetch(list = wishlist, params: {})
    host! owner.subdomain
    get "/wishlists/#{list.external_id}/products", params: { page: "1" }.merge(params), headers: json_headers
  end

  it "lists the cards of a public wishlist", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, user: create(:user, name: "Ebook Seller"), name: "First ebook", price_cents: 500))
    create(:wishlist_product, wishlist:, product: create(:product, user: create(:user, name: "Course Seller"), name: "Second course", price_cents: 1250))

    fetch

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["items"].map { _1.dig("product", "name") }).to eq(["First ebook", "Second course"])
    expect(response.parsed_body["pagination"]).to include("count" => 2, "page" => 1, "pages" => 1)
  end

  it "answers an empty wishlist", parity: true do
    fetch

    expect(response.parsed_body).to include("items" => [])
    expect(response.parsed_body["pagination"]).to include("count" => 0, "page" => 1)
  end

  it "serves the second page of twenty-one products", parity: true do
    seller = create(:user, name: "Prolific Seller")
    21.times { |index| create(:wishlist_product, wishlist:, product: create(:product, user: seller, name: "Item #{index}")) }

    fetch(params: { page: "2" })

    expect(response.parsed_body["items"].size).to eq(1)
    expect(response.parsed_body["pagination"]).to include("count" => 21, "page" => 2, "pages" => 2, "prev" => 1, "next" => nil)
  end

  it "answers an empty page past the last one", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, name: "Only one"))

    fetch(params: { page: "9" })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["items"]).to eq([])
  end

  it "leaves out a removed wishlist product", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, name: "Kept"))
    create(:wishlist_product, wishlist:, product: create(:product, name: "Removed"), deleted_at: 1.day.ago)

    fetch

    expect(response.parsed_body["items"].map { _1.dig("product", "name") }).to eq(["Kept"])
  end

  it "marks a gift as available to a signed-in buyer", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, name: "Giftable"))
    log_in(buyer)

    fetch

    expect(response.parsed_body["items"].first).to include("giftable" => true, "purchasable" => true)
  end

  it "withholds the gift from the owner", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, name: "Own wish"))
    log_in(owner)

    fetch

    expect(response.parsed_body["items"].first).to include("giftable" => false)
  end

  it "withholds the gift when the product's seller disabled gifting", parity: true do
    seller = create(:user)
    seller.update!(gifting_disabled: true)
    create(:wishlist_product, wishlist:, product: create(:product, user: seller, name: "No gifts"))

    fetch

    expect(response.parsed_body["items"].first).to include("giftable" => false)
  end

  it "marks an unpublished product as not purchasable", parity: true do
    create(:wishlist_product, wishlist:, product: create(:product, name: "Draft", purchase_disabled_at: Time.current))

    fetch

    expect(response.parsed_body["items"].first).to include("purchasable" => false)
  end

  it "carries the version, quantity and rent of a wishlist product", parity: true do
    versioned = create(:product_with_digital_versions, name: "Versioned", price_cents: 800)
    rental = create(:product, name: "Rental", purchase_type: "buy_and_rent", price_cents: 500, rental_price_cents: 300)
    physical = create(:product, name: "Quantity", price_cents: 1000, quantity_enabled: true)
    create(:wishlist_product, wishlist:, product: versioned, variant: versioned.variant_categories.first.variants.first)
    create(:wishlist_product, wishlist:, product: rental, rent: true)
    create(:wishlist_product, wishlist:, product: physical, quantity: 2)

    fetch

    items = response.parsed_body["items"]
    expect(items.first["option"]).to include("name" => versioned.variant_categories.first.variants.first.name)
    expect(items.second).to include("rent" => true)
    expect(items.third).to include("quantity" => 2)
  end

  it "answers 404 for a wishlist that does not exist", parity: true do
    host! owner.subdomain
    get "/wishlists/nosuchwishlist/products", params: { page: "1" }, headers: json_headers

    expect(response).to have_http_status(:not_found)
  end

  it "lists a wishlist product with a sku", parity: true do
    physical = create(:physical_product, skus_enabled: true)
    create(:sku, link: physical, name: "Large")
    create(:wishlist_product, wishlist:, product: physical, variant: physical.skus.not_is_default_sku.first)

    fetch

    expect(response.parsed_body["items"].first["option"]).to include("name" => "Large")
  end
end
