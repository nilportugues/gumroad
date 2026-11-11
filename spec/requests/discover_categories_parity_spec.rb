# frozen_string_literal: true

require "spec_helper"

# GET /discover/categories routes to an action DiscoverController does not define: Rails raises ActionNotFound before any filter runs,
# so Node answers a visitor and hands a signed-in seller back (it would seed the dashboard nav items first). Recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/discover-categories.replay.test.ts.
describe "Discover categories", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  it "answers 404 to a visitor", parity: true do
    get "/discover/categories"

    expect(response).to have_http_status(:not_found)
  end

  it "hands a signed-in seller to Rails", parity: true do
    log_in(create(:user, name: "Categories Seller", username: "categoriesseller"))

    get "/discover/categories"

    expect(response).to have_http_status(:not_found)
  end
end
