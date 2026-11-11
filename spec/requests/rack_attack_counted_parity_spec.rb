# frozen_string_literal: true

require "spec_helper"

# Routes Rack::Attack throttles that Node serves and counts itself (nextjs/src/server/controllers/rack-attack.ts): v2 sales past page 10, the profile
# custom HTML write and preview, and the mobile download. Each example sends a request from a non-local address (localhost is safelisted) and
# either reads the counters Rack::Attack wrote or fills the first throttle and expects its 429. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/rack-attack-counted.replay.test.ts; an example named "hands ..." is one Node cannot
# prove, which must reach Rails whole and leave no count behind.
describe "Throttled routes counted in Node", type: :request do
  include Parity::ApiV2Requests

  let(:ip) { "203.0.113.77" }
  let(:seller) { create(:user, name: "Throttled Seller") }
  let(:counted) { { "CF-Connecting-IP" => ip } }
  let(:redis) { Rack::Attack.cache.store }

  before do
    redis.flushdb
    Feature.activate_user(:custom_html_pages, seller)
  end

  after { redis.flushdb }

  def counters = redis.keys("rack::attack:*").sort.to_h { |key| [key.sub(/\Arack::attack:\d+:/, ""), redis.get(key).to_i] }

  # Puts the first throttle of a request on its limit, as a client that has sent that many requests would.
  def fill(path, method:, limit:, query: "")
    limit.times do
      Rack::Attack.configuration.throttled?(
        Rack::Attack::Request.new(Rack::MockRequest.env_for("#{path}#{query}", method:, "HTTP_CF_CONNECTING_IP" => ip, "HTTP_AUTHORIZATION" => "Bearer #{@token.token}"))
      )
    end
  end

  def expect_too_many_requests
    expect(response).to have_http_status(:too_many_requests)
    expect(response.body).to eq("Retry later\n")
    expect(response.headers["Retry-After"]).to be_present
  end

  describe "GET /v2/sales" do
    before { @token = api_token(seller, scopes: "view_sales") }

    it "does not count a page up to ten", parity: true do
      api_call(:get, "/sales", token: @token, params: { page: 10 }, headers: counted, api_host: false)

      expect(response).to have_http_status(:ok)
      expect(counters).to eq({})
    end

    it "counts a page past ten", parity: true do
      api_call(:get, "/sales", token: @token, params: { page: 11 }, headers: counted, api_host: false)

      expect(counters).to eq("/api/v2/sales:#{ip}" => 1)
    end

    it "answers 429 past ten pages in a second", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/api/v2/sales", method: "GET", limit: 10, query: "?page=11")

        api_call(:get, "/sales", token: @token, params: { page: 11 }, headers: counted, api_host: false)
      end

      expect_too_many_requests
    end
  end

  describe "PATCH /v2/user/custom_html" do
    before { @token = api_token(seller, scopes: "edit_profile") }

    it "counts a refusal in the address and token tiers", parity: true do
      api_call(:patch, "/user/custom_html", token: @token, params: {}, headers: counted, api_host: false)

      expect(response.parsed_body["success"]).to be(false)
      expect(counters.size).to eq(11)
      expect(counters.values.uniq).to eq([1])
    end

    it "hands a valid update to Rails", parity: true do
      api_call(:patch, "/user/custom_html", token: @token, params: { custom_html: "<p>Hello</p>" }, headers: counted, api_host: false)

      expect(response).to have_http_status(:ok)
    end

    it "answers 429 past the per-IP limit", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/api/v2/user/custom_html", method: "PATCH", limit: 30)

        api_call(:patch, "/user/custom_html", token: @token, params: { custom_html: "<p>Hello</p>" }, headers: counted, api_host: false)
      end

      expect_too_many_requests
    end
  end

  describe "POST /v2/user/preview_custom_html" do
    before { @token = api_token(seller, scopes: "edit_profile") }

    it "counts a refusal in the address and token tiers", parity: true do
      api_call(:post, "/user/preview_custom_html", token: @token, params: {}, headers: counted, api_host: false)

      expect(response.parsed_body["success"]).to be(false)
      expect(counters.size).to eq(11)
      expect(counters.values.uniq).to eq([1])
    end

    it "answers 429 past the per-IP limit", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/api/v2/user/preview_custom_html", method: "POST", limit: 60)

        api_call(:post, "/user/preview_custom_html", token: @token, params: {}, headers: counted, api_host: false)
      end

      expect_too_many_requests
    end
  end

  describe "GET /mobile/url_redirects/download/:token/:product_file_id" do
    include Parity::MobileApi

    let(:product) { create(:product, user: seller) }
    let!(:product_file) { create(:readable_document, link: product) }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: create(:user), email: "buyer@example.com") }
    let!(:url_redirect) { purchase.create_url_redirect! }
    let(:path) { "/mobile/url_redirects/download/#{url_redirect.token}/#{product_file.external_id}" }

    before { purchase.update_attribute(:is_access_revoked, true) }

    it "counts a refusal per token and file", parity: true do
      get path, params: { mobile_token: }, headers: counted

      expect(response).to have_http_status(:not_found)
      # The throttle downcases its discriminator.
      expect(counters).to eq("mobile_url_redirect_download/token:#{url_redirect.token}/#{product_file.external_id}".downcase => 1)
    end

    it "answers 429 past sixty downloads of a file in a minute", parity: true do
      @token = Struct.new(:token).new("none")
      travel_to(Time.current.change(usec: 0)) do
        fill(path, method: "GET", limit: 60)

        get path, params: { mobile_token: }, headers: counted
      end

      expect_too_many_requests
    end
  end
end
