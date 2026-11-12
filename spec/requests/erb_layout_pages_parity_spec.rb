# frozen_string_literal: true

require "spec_helper"

# The ERB layout pages (layouts/home + layouts/application), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/erb-layout-pages.replay.test.ts. The bodies carry a per-request CSRF token and CSP nonce; the replay masks both.
# An example named "hands a ..." is one Node leaves to Rails whole.
describe "ERB layout pages", type: :request do
  include Parity::AudienceSignedIn

  let(:stars_key) { "github_stars_antiwork/gumroad" }

  before do
    host! DOMAIN
    Rails.cache.write(stars_key, 12_345)
  end

  describe "McpConnectorsController" do
    it "renders the index of connectors", parity: true do
      get "/mcp"

      expect(response).to be_successful
      expect(response.body).to include("Gumroad MCP")
    end

    it "renders the page of a connector listed in the directory", parity: true do
      get "/claude"

      expect(response).to be_successful
      expect(response.body).to include("Add Gumroad to Claude")
    end

    it "renders the page of a connector submitted for review", parity: true do
      get "/muse"

      expect(response).to be_successful
      expect(response.body).to include("Technical details")
    end

    it "renders a connector page for a signed-in seller", parity: true do
      log_in(create(:user))

      get "/claude"

      expect(response.body).to include("Dashboard")
    end
  end

  describe "GET /gumclaw" do
    it "renders the page for a visitor with no cookies", parity: true do
      get "/gumclaw"

      expect(response).to be_successful
      expect(response.body).to include("Gumroad is run")
      expect(response.body).to include("12.3K")
    end

    it "renders the page for a visitor who already has a guid", parity: true do
      get "/gumclaw", headers: { "Cookie" => "_gumroad_guid=abc123" }

      expect(response).to be_successful
      expect(response.headers["Set-Cookie"]).not_to include("_gumroad_guid")
    end

    it "marks the body of a Mac visitor", parity: true do
      get "/gumclaw", headers: { "User-Agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }

      expect(response.body).to include('class="group/body mac"')
    end

    it "renders the page whatever the query string says", parity: true do
      get "/gumclaw", params: { ref: "footer" }

      expect(response).to be_successful
    end

    it "renders a visitor on the page without a cached star count", parity: true do
      Rails.cache.delete(stars_key)
      stub_request(:get, "https://api.github.com/repos/antiwork/gumroad")
        .to_return(status: 200, body: { stargazers_count: 4242 }.to_json, headers: { "Content-Type" => "application/json" })

      get "/gumclaw"

      expect(response).to be_successful
      expect(response.body).to include("4.2K")
    end

    it "renders a visitor whose star count lookup failed", parity: true do
      Rails.cache.write(stars_key, nil)

      get "/gumclaw"

      expect(response).to be_successful
      expect(response.body).to include(">GitHub</span>")
    end

    it "renders the Dashboard link for a signed-in seller", parity: true do
      seller = create(:user)
      log_in(seller)

      get "/gumclaw"

      expect(response).to be_successful
      expect(response.body).to include("Dashboard")
    end
  end
end
