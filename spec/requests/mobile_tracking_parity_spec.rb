# frozen_string_literal: true

require "spec_helper"

# GET /links/:link_id/in_app (Products::MobileTrackingController#show), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12o.replay.test.ts, which sends the last request of each example. Node answers the 404 of a product that is
# gone; an example named "hands a ..." is a live product, whose ERB page Node leaves to Rails whole.
describe "Mobile tracking page", type: :request do
  let(:seller) { create(:user, name: "Tracking Seller") }
  let(:product) { create(:product, user: seller, name: "Tracked product", unique_permalink: "trackme", created_at: Time.utc(2025, 1, 1)) }

  before { host! DOMAIN }

  it "answers 404 for an unknown product", parity: true do
    get "/links/nonexistent/in_app"

    expect(response).to have_http_status(:not_found)
  end

  # The test environment answers a 404 with DebugExceptions' HTML page whatever the request asks for (production's
  # PublicExceptions would answer JSON for the first two), so each example pins that the port does not vary with Accept.
  {
    "an Accept of only application/json" => { "Accept" => "application/json" },
    "an Accept of application/json then text/html" => { "Accept" => "application/json, text/html" },
    "a wildcard Accept" => { "Accept" => "*/*" },
    "an XHR asking for JSON" => { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest" },
  }.each do |description, headers|
    it "answers 404 for an unknown product with #{description}", parity: true do
      get("/links/nonexistent/in_app", headers:)

      expect(response).to have_http_status(:not_found)
    end
  end

  it "answers 404 for a deleted product", parity: true do
    product.update_column(:deleted_at, Time.utc(2025, 2, 1))

    get "/links/#{product.unique_permalink}/in_app"

    expect(response).to have_http_status(:not_found)
  end

  it "hands a live product to Rails", parity: true do
    get "/links/#{product.unique_permalink}/in_app"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("trackme")
  end

  it "hands a product of a seller with third party analytics to Rails", parity: true do
    seller.update!(google_analytics_id: "G-12345678")

    get "/links/#{product.unique_permalink}/in_app"

    expect(response).to have_http_status(:ok)
  end
end
