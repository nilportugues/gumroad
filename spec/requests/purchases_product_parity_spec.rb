# frozen_string_literal: true

require "spec_helper"

# GET /purchases/:id/product (Purchases::ProductController#show), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchase-pages-guards.replay.test.ts. Node answers the 404 of set_purchase; an example named "hands a ..." is
# one it leaves to Rails whole, because Rails rebuilds the product from its PaperTrail version at the time of the purchase, or, for a
# buyer who signed in, because Purchase#purchase_info is built before the presenter overrides `purchase` with nil.
describe "Purchase product page", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Product Page Seller") }
  let(:product) { create(:product, user: seller, name: "As purchased", unique_permalink: "aspurchased", created_at: Time.utc(2025, 1, 1)) }
  # A charged purchase would call Stripe.
  let(:purchase) { build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) } }

  before { host! DOMAIN }

  it "answers 404 for a purchase that does not exist", parity: true do
    get "/purchases/nosuchpurchase/product"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an external id that decodes to no purchase", parity: true do
    get "/purchases/#{ObfuscateIds.encrypt(987_654_321)}/product"

    expect(response).to have_http_status(:not_found)
  end

  it "renders the product as it stood when the purchase was made", parity: true do
    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
    expect(response.body).to include("Purchases/Product/Show")
    expect(response.headers["X-Robots-Tag"]).to include("noindex")
  end

  it "renders the product to a seller who signed in", parity: true do
    log_in(seller)

    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
    expect(response.body).to include("Purchases/Product/Show")
  end

  it "renders the product to a signed-in visitor who is nobody to the product", parity: true do
    log_in(create(:user, name: "Passing Visitor"))

    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
    expect(response.body).to include("Purchases/Product/Show")
  end

  it "hands a buyer who signed in to Rails", parity: true do
    buyer = create(:user, name: "Signed In Buyer")
    purchase.update_columns(purchaser_id: buyer.id)
    log_in(buyer)

    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
    expect(response.body).to include("Purchases/Product/Show")
  end

  it "hands a product with variants to Rails, which rebuilds the options as of the purchase", parity: true do
    category = create(:variant_category, link: product, title: "Tier")
    create(:variant, variant_category: category, name: "Early tier", created_at: Time.utc(2025, 1, 1))
    create(:variant, variant_category: category, name: "Zebra tier", created_at: Time.current + 1.day)

    get "/purchases/#{purchase.external_id}/product"

    expect(response.body).to include("Early tier")
    expect(response.body).not_to include("Zebra tier")
  end

  it "hands a product edited after the purchase to Rails, which rebuilds it from its version", parity: true, versioning: true do
    purchase
    product.update!(name: "Renamed after the purchase")

    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
  end

  it "hands a request that does not ask for HTML to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/product", headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:not_found)
  end
end
