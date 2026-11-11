# frozen_string_literal: true

require "spec_helper"

# HomeController#features_md, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/home-pages.replay.test.ts. The other home#* actions render ERB templates in the home layout.
describe "Home pages", type: :request do
  before { host! DOMAIN }

  describe "GET /features.md" do
    it "serves the feature list as publicly cacheable markdown without cookies", parity: true do
      get "/features.md"

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("text/markdown")
      expect(response.body).to start_with("# Gumroad features")
      expect(response.headers["Cache-Control"]).to include("s-maxage=300")
      expect(response.headers["Set-Cookie"]).to be_nil
    end

    it "hands a request that carries a cookie to Rails", parity: true do
      get "/features.md", headers: { "Cookie" => "_gumroad_guid=abc123" }

      expect(response).to have_http_status(:ok)
      expect(response.headers["Cache-Control"]).to include("private")
    end

    it "hands a request with utm parameters to Rails", parity: true do
      get "/features.md", params: { utm_source: "newsletter" }

      expect(response).to have_http_status(:ok)
      expect(response.headers["Cache-Control"]).to include("private")
    end
  end
end
