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

    it "stays edge cacheable with a list and a hash in the query", parity: true do
      get "/terms?tags[]=a&tags[]=b&filter[kind]=x"

      expect(response).to be_successful
      expect(set_cookies).to be_empty
      expect(response.headers["Cache-Control"]).to include("s-maxage=300")
    end

    it "stays edge cacheable with a hash nested more than one level deep", parity: true do
      get "/terms?filter[kind][deep]=x&tags[a][]=b"

      expect(response).to be_successful
      expect(set_cookies).to be_empty
      expect(response.headers["Cache-Control"]).to include("s-maxage=300")
    end

    it "takes the normal path for a utm_ parameter nested more than one level deep", parity: true do
      get "/terms?utm_source[a][b]=1"

      expect(response).to be_successful
      expect(set_cookies).to include("_gumroad_guid")
    end

    it "makes the body transparent for an as_embed nested more than one level deep", parity: true do
      get "/terms?as_embed[a][b]=1"

      expect(response.body).to include('style="background: transparent"')
    end

    it "takes the normal path for a utm_ parameter that is a hash", parity: true do
      get "/terms?utm_source[a]=1"

      expect(response).to be_successful
      expect(set_cookies).to include("_gumroad_guid")
    end

    it "makes the body transparent for an as_embed list", parity: true do
      get "/terms?as_embed[]=1"

      expect(response.body).to include('style="background: transparent"')
    end

    it "answers a HEAD request with the headers of the GET and no body", parity: true do
      head "/terms"

      expect(response).to be_successful
      expect(response.body).to be_empty
      expect(response.headers["Content-Type"]).to include("text/html")
    end

    it "makes the body transparent for as_embed", parity: true do
      get "/terms", params: { as_embed: "true" }

      expect(response.body).to include('style="background: transparent"')
    end

    it "makes the body transparent for an empty as_embed", parity: true do
      get "/terms?as_embed="

      expect(response.body).to include('style="background: transparent"')
    end

    it "leaves the body alone for an as_embed without a value", parity: true do
      get "/terms?as_embed"

      expect(response.body).to include('style=""')
    end

    it "renders the toast of a flash the previous request left", parity: true do
      post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: "nobody@example.com", password: "wrong" } }
      expect(response).to have_http_status(:see_other)

      get "/terms"

      expect(response.body).to include('id="flash-toast"')
    end

    it "renders the toast of an alert flash", parity: true do
      get "/users/confirmation", params: { confirmation_token: "superseded-token" }
      expect(response).to redirect_to(root_path)

      get "/terms"

      expect(response.body).to include('id="flash-toast"')
      expect(response.body).to include("This confirmation link is no longer valid")
    end

    it "renders the toast of a notice flash", parity: true do
      get "/users/unsubscribe/#{create(:user).secure_external_id(scope: "email_unsubscribe", expires_at: 2.days.from_now)}", params: { email_type: "notify" }
      expect(response).to redirect_to(root_path)

      get "/terms"

      expect(response.body).to include("You have been unsubscribed from purchase notifications.")
    end

    it "renders the Dashboard link to an admin impersonating a seller", parity: true do
      admin = create(:admin_user, name: "Gumlord")
      seller = create(:named_seller)
      log_in(admin)
      get admin_impersonate_path(user_identifier: seller.email)
      expect(response).to redirect_to(products_path)

      get "/terms"

      expect(response).to be_successful
      expect(response.body).to include("Dashboard")
    end

    it "marks the body of a Mac visitor", parity: true do
      get "/terms", headers: { "User-Agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }

      expect(response.body).to include('class="group/body mac"')
    end

    it "renders the Dashboard link for a signed-in seller", parity: true do
      log_in(create(:user))

      get "/terms"

      expect(response).to be_successful
      expect(response.body).to include("Dashboard")
    end

    it "renders a visitor on the page without a cached star count", parity: true do
      Rails.cache.delete(stars_key)
      stub_request(:get, "https://api.github.com/repos/antiwork/gumroad")
        .to_return(status: 200, body: { stargazers_count: 4242 }.to_json, headers: { "Content-Type" => "application/json" })

      get "/privacy"

      expect(response).to be_successful
      expect(response.body).to include("4.2K")
    end
  end
end
