# frozen_string_literal: true

require "spec_helper"

# GET /purchases/:id/product (Purchases::ProductController#show), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchase-pages-guards.replay.test.ts. Node answers the 404 of set_purchase; an example named "hands a ..." is
# one it leaves to Rails whole, because Rails rebuilds the product from its PaperTrail version at the time of the purchase.
describe "Purchase product page", type: :request do
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

  it "hands the page of a purchase that exists to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/product"

    expect(response).to be_successful
  end

  it "hands a request that does not ask for HTML to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/product", headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:not_found)
  end
end
