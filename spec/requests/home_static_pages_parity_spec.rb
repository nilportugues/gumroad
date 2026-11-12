# frozen_string_literal: true

require "spec_helper"

# The static marketing pages of HomeController (home layout), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/home-static-pages.replay.test.ts. A request with no cookies, no utm_* param and the GET method is edge
# cacheable: no session, guid or XSRF-TOKEN cookie and `public, s-maxage` caching. Any other request takes the normal path.
# An example named "hands a ..." is one Node leaves to Rails whole.
describe "Home static pages", type: :request do
  include Parity::AudienceSignedIn

  let(:stars_key) { "github_stars_antiwork/gumroad" }

  before do
    host! DOMAIN
    Rails.cache.write(stars_key, 12_345)
  end

  %w[terms privacy prohibited dpa about pricing features saas hackathon small-bets].each do |page|
    describe "GET /#{page}" do
      it "renders the page edge cacheable for a visitor with no cookies", parity: true do
        get "/#{page}"

        expect(response).to be_successful
        expect(set_cookies).to be_empty
        expect(response.headers["Cache-Control"]).to include("s-maxage=300")
      end
    end
  end

  describe "GET /about" do
    it "prints the payout figure Redis holds", parity: true do
      $redis.set(RedisKey.prev_week_payout_usd, "1234567890")

      get "/about"

      expect(response).to be_successful
      expect(response.body).to include("$1,234,567,890")
    end

    it "prints the default figure for a blank payout", parity: true do
      $redis.set(RedisKey.prev_week_payout_usd, "  ")

      get "/about"

      expect(response).to be_successful
      expect(response.body).to include("$3,129,297")
    end

    it "prints the payout figure to a visitor with a guid", parity: true do
      $redis.set(RedisKey.prev_week_payout_usd, "987654")

      get "/about", headers: { "Cookie" => "_gumroad_guid=abc123" }

      expect(response.body).to include("$987,654")
      expect(response.headers["Cache-Control"]).not_to include("public")
    end
  end

  describe "edge cacheable rules" do
    it "keeps a query string out of the way of caching", parity: true do
      get "/terms", params: { ref: "footer" }

      expect(response).to be_successful
      expect(set_cookies).to be_empty
      expect(response.headers["Cache-Control"]).to include("public")
    end

    it "takes the normal path for a visitor who already has a guid", parity: true do
      get "/privacy", headers: { "Cookie" => "_gumroad_guid=abc123" }

      expect(response).to be_successful
      expect(response.headers["Cache-Control"]).not_to include("public")
      expect(set_cookies).to include("_gumroad_app_session")
      expect(set_cookies).to include("XSRF-TOKEN")
      expect(response.body).to include("csrf-token")
    end

    it "takes the normal path for a visitor with any other cookie", parity: true do
      get "/dpa", headers: { "Cookie" => "theme=dark" }

      expect(response).to be_successful
      expect(set_cookies).to include("_gumroad_guid")
    end

    it "takes the normal path for a utm_ parameter", parity: true do
      get "/prohibited", params: { utm_source: "newsletter" }

      expect(response).to be_successful
      expect(set_cookies).to include("_gumroad_guid")
      expect(response.headers["Cache-Control"]).not_to include("public")
    end

    it "marks the body of a Mac visitor", parity: true do
      get "/terms", headers: { "User-Agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }

      expect(response.body).to include('class="group/body mac"')
    end

    it "hands a signed-in seller to Rails", parity: true do
      log_in(create(:user))

      get "/terms"

      expect(response).to be_successful
      expect(response.body).to include("Dashboard")
    end

    it "hands a visitor on the page without a cached star count to Rails", parity: true do
      Rails.cache.delete(stars_key)
      stub_request(:get, "https://api.github.com/repos/antiwork/gumroad")
        .to_return(status: 200, body: { stargazers_count: 4242 }.to_json, headers: { "Content-Type" => "application/json" })

      get "/privacy"

      expect(response).to be_successful
      expect(response.body).to include("4.2K")
    end
  end
end
