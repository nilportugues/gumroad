# frozen_string_literal: true

require "spec_helper"

# The redirect-only routes after a real login: no controller runs, so the answer is the signed-out one. Recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/route-redirects.replay.test.ts.
describe "Route redirects when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Redirect Seller") }

  def location_path
    URI.parse(response.location).then { |uri| [[uri.path, uri.query].compact.join("?"), uri.fragment].compact.join("#") }
  end

  before { log_in(seller) }

  it "sends the old audience page to the dashboard audience", parity: true do
    get "/audience"

    expect(response).to have_http_status(:moved_permanently)
    expect(location_path).to eq("/dashboard/audience")
  end

  it "sends the old product page to the product page with the query string dropped", parity: true do
    get "/products/abc?affiliate_id=1"

    expect(response).to have_http_status(:moved_permanently)
    expect(location_path).to eq("/l/abc")
  end

  it "keeps the query string of the old profile settings", parity: true do
    get "/settings/profile?x=1"

    expect(response).to have_http_status(:moved_permanently)
    expect(location_path).to eq("/profile?x=1")
  end

  it "sends the old posts page to the emails page", parity: true do
    get "/posts"

    expect(response).to have_http_status(:moved_permanently)
    expect(location_path).to eq("/emails")
  end
end
