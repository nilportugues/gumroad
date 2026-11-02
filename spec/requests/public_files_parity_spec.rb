# frozen_string_literal: true

require "spec_helper"

# The small public endpoints with no page behind them (robots.txt, llms.txt, the favicon, ACME challenges,
# the IndexNow key, crossdomain.xml, the GitHub stars counter), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws11-public.replay.test.ts.
describe "Public files", type: :request do
  let(:seller) { create(:named_user) }
  # Production serves public/ from nginx, not from Rack::Static, which would answer /favicon.ico before the router.
  before do
    allow_any_instance_of(ActionDispatch::Static).to receive(:call) { |static, env| static.instance_variable_get(:@app).call(env) }
  end

  let(:seller_host) { Subdomain.from_username(seller.username).split(":").first }

  describe "GET /robots.txt" do
    before do
      RobotsService.new.send(:redis_namespace).set("sitemap_configs", ["Sitemap: https://cdn.example.com/sitemap/sitemap.xml.gz"].to_json)
    end

    it "lists the sitemaps on the Gumroad domain", parity: true do
      host! DOMAIN

      get "/robots.txt"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Sitemap: https://cdn.example.com/sitemap/sitemap.xml.gz")
    end

    it "gives a seller storefront the crawl delay and no sitemaps", parity: true do
      host! seller_host

      get "/robots.txt"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Crawl-delay: 10")
      expect(response.body).not_to include("Sitemap:")
    end
  end

  describe "GET /llms.txt" do
    it "serves the AI-assistant overview", parity: true do
      host! DOMAIN

      get "/llms.txt"

      expect(response).to have_http_status(:ok)
      expect(response.body).to start_with("# Gumroad")
    end
  end

  describe "GET /favicon.ico" do
    it "redirects a seller subdomain to the seller's avatar", parity: true do
      host! seller_host

      get "/favicon.ico"

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/images/gumroad-default-avatar")
    end

    it "redirects a seller custom domain to the seller's avatar", parity: true do
      create(:custom_domain, user: seller, domain: "www.example-seller.com")
      host! "www.example-seller.com"

      get "/favicon.ico"

      expect(response).to have_http_status(:found)
    end

    it "redirects a product custom domain to the product seller's avatar", parity: true do
      product = create(:product, user: seller)
      create(:custom_domain, :with_product, product:, domain: "www.example-product.com")
      host! "www.example-product.com"

      get "/favicon.ico"

      expect(response).to have_http_status(:found)
    end

    it "serves the static icon on the Gumroad domain", parity: true do
      host! DOMAIN

      get "/favicon.ico"

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("image/x-icon")
    end

    it "serves the static icon for a subdomain no seller owns", parity: true do
      host! Subdomain.from_username("no-such-seller").split(":").first

      get "/favicon.ico"

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("image/x-icon")
    end
  end

  describe "GET /:key.txt" do
    let(:key) { "AbCd-1234-EfGh-5678" }

    around do |example|
      previous = ENV["INDEXNOW_KEY"]
      ENV["INDEXNOW_KEY"] = key
      example.run
    ensure
      ENV["INDEXNOW_KEY"] = previous
    end

    it "serves the key as plain text", parity: true do
      host! DOMAIN

      get "/#{key}.txt"

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq(key)
      expect(response.media_type).to eq("text/plain")
    end

    it "serves the key on a seller subdomain", parity: true do
      host! seller_host

      get "/#{key}.txt"

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq(key)
    end

    it "answers 404 for a different key", parity: true do
      host! DOMAIN

      get "/#{"c" * 32}.txt"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /.well-known/acme-challenge/:token" do
    let(:token) { "a" * 43 }

    before { $redis.set(RedisKey.acme_challenge(token), "challenge-response-content") }
    after { $redis.del(RedisKey.acme_challenge(token)) }

    it "serves the staged challenge on a seller custom domain", parity: true do
      custom_domain = create(:custom_domain, user: seller)
      host! custom_domain.domain

      get "/.well-known/acme-challenge/#{token}"

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq("challenge-response-content")
    end

    it "serves the staged challenge on a product custom domain", parity: true do
      custom_domain = create(:custom_domain, user: nil, product: create(:product))
      host! custom_domain.domain

      get "/.well-known/acme-challenge/#{token}"

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 when no challenge is staged for the token", parity: true do
      custom_domain = create(:custom_domain, user: seller)
      host! custom_domain.domain

      get "/.well-known/acme-challenge/#{"b" * 43}"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 400 for a token with a character outside the allowed set", parity: true do
      custom_domain = create(:custom_domain, user: seller)
      host! custom_domain.domain

      get "/.well-known/acme-challenge/#{"a" * 20}%2B#{"a" * 20}"

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 400 for a token longer than 64 characters", parity: true do
      custom_domain = create(:custom_domain, user: seller)
      host! custom_domain.domain

      get "/.well-known/acme-challenge/#{"a" * 65}"

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "GET /crossdomain" do
    it "serves the cross-domain policy", parity: true do
      host! DOMAIN

      get "/crossdomain.xml"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("<cross-domain-policy>")
    end
  end

  describe "GET /github_stars" do
    it "serves the cached star count", parity: true do
      host! DOMAIN
      Rails.cache.write("github_stars_antiwork/gumroad", 5818, expires_in: 1.hour)

      get "/github_stars"

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("stars" => 5818)
      expect(response.headers["Cache-Control"]).to include("max-age=3600, public")
    end
  end
end
