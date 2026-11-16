# frozen_string_literal: true

require "spec_helper"

# GET /recommended_products (RecommendedProductsController#index), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12o.replay.test.ts, which sends the last request of each example. Node answers `[]` when the cart has no seller
# to recommend from; an example named "hands a ..." has one, and Node leaves it to Rails whole because its cards come from the sales index,
# a random sample and Elasticsearch.
describe "Recommended products", type: :request do
  let(:seller) { create(:user, name: "Recommending Seller") }
  let(:product) { create(:product, user: seller, name: "Cart product", unique_permalink: "recocart", created_at: Time.utc(2025, 1, 1)) }
  let(:opted_out_seller) { create(:user, name: "Quiet Seller", recommendation_type: User::RecommendationType::NO_RECOMMENDATIONS) }
  let(:opted_out_product) { create(:product, user: opted_out_seller, name: "Quiet product", unique_permalink: "quietcart", created_at: Time.utc(2025, 1, 2)) }

  before { host! DOMAIN }

  def recommend(params)
    get "/recommended_products", params:, headers: { "Accept" => "application/json, text/html" }
  end

  it "answers an empty list for a cart with no products", parity: true do
    recommend(limit: "5")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when the cart product ids do not decrypt", parity: true do
    recommend(cart_product_ids: ["not-an-id"], limit: "5")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a cart product that does not exist", parity: true do
    recommend(cart_product_ids: [ObfuscateIds.encrypt(product.id + 1000)], limit: "5")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when the request asks for no recommendations", parity: true do
    recommend(cart_product_ids: [product.external_id], limit: "5", recommendation_type: User::RecommendationType::NO_RECOMMENDATIONS)

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a cart whose seller opted out of recommendations", parity: true do
    recommend(cart_product_ids: [opted_out_product.external_id], limit: "5")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a limit of zero", parity: true do
    recommend(cart_product_ids: [opted_out_product.external_id], limit: "0")

    expect(response.parsed_body).to eq([])
  end

  it "hands a cart of a seller who recommends to Rails", parity: true do
    recommend(cart_product_ids: [product.external_id], limit: "5")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq([])
  end

  it "hands a cart of an opted-out seller to Rails when the request names a recommendation type", parity: true do
    recommend(cart_product_ids: [opted_out_product.external_id], limit: "5", recommendation_type: User::RecommendationType::OWN_PRODUCTS)

    expect(response).to have_http_status(:ok)
  end

  it "hands a request without a limit to Rails", parity: true do
    recommend(cart_product_ids: [product.external_id])

    expect(response).to have_http_status(:bad_request)
  end
end
