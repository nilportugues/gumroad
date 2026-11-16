# frozen_string_literal: true

require "spec_helper"

# The route-level redirect from the old invoice URL, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws75-pages.replay.test.ts.
describe "Generate invoice redirect", type: :request do
  before { host! DOMAIN }

  it "sends the old invoice URL to the new invoice page", parity: true do
    get "/purchases/abc123/generate_invoice"

    expect(response).to have_http_status(:moved_permanently)
    expect(response.location).to end_with("/purchases/abc123/invoice/new")
  end

  it "keeps the query string", parity: true do
    get "/purchases/abc123/generate_invoice", params: { email: "buyer@example.com", note: "a b" }

    expect(response).to have_http_status(:moved_permanently)
    expect(response.location).to end_with("/purchases/abc123/invoice/new?email=buyer%40example.com&note=a+b")
  end
end
