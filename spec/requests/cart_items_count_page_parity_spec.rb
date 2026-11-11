# frozen_string_literal: true

require "spec_helper"

# GET /cart_items_count without JSON (LinksController#cart_items_count, `format.any`): the Inertia frame a custom domain embeds from the
# root domain. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12p.replay.test.ts, which
# sends the last request of each example. The JSON answer is recorded in product_editor_json_signed_in_spec.rb.
describe "Cart items count frame", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Cart Seller", username: "cartseller") }
  let(:product) { create(:product, user: seller, name: "Carted product", unique_permalink: "cartprod", price_cents: 500, created_at: Time.utc(2025, 1, 1)) }
  let(:guid) { "parity-frame-browser-guid" }
  let(:inertia) { { "X-Inertia" => "true" } }

  before { host! DOMAIN }

  it "renders the count of a guest cart's alive lines", parity: true do
    cart = create(:cart, :guest, browser_guid: guid)
    create(:cart_product, cart:, product:)
    create(:cart_product, cart:, product: create(:product, user: seller), deleted_at: Time.utc(2025, 2, 1))
    cookies[:_gumroad_guid] = guid

    get cart_items_count_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("cart_items_count" => 1)
  end

  it "renders zero for a visitor without a cart", parity: true do
    get cart_items_count_path

    expect(inertia_props_of(response)).to include("cart_items_count" => 0)
  end

  it "renders the count of the first alive cart of a signed-in user", parity: true do
    cart = create(:cart, user: seller)
    create(:cart_product, cart:, product:)
    create(:cart_product, cart:, product: create(:product, user: seller, name: "Second"))
    log_in(seller)

    get cart_items_count_path

    expect(inertia_props_of(response)).to include("cart_items_count" => 2)
  end

  it "answers an Inertia request with the page object", parity: true do
    cart = create(:cart, :guest, browser_guid: guid)
    create(:cart_product, cart:, product:)
    cookies[:_gumroad_guid] = guid

    get cart_items_count_path, headers: inertia

    expect(response.parsed_body).to include("component" => "Products/CartItemsCount", "props" => include("cart_items_count" => 1))
  end

  it "turns off third-party analytics in the page's meta tags", parity: true do
    get cart_items_count_path, headers: inertia

    expect(response.parsed_body["props"]["_inertia_meta"]).to include(include("property" => "gr:google_analytics:enabled", "content" => "false"))
  end

  it "hands a request on the seller's subdomain to Rails", parity: true do
    host! seller.subdomain
    create(:cart_product, cart: create(:cart, :guest, browser_guid: guid), product:)
    cookies[:_gumroad_guid] = guid

    get "/cart_items_count", headers: inertia

    expect(response.parsed_body).to include("component" => "Products/CartItemsCount")
  end
end
