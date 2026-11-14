# frozen_string_literal: true

require "spec_helper"

# The routes Node serves and counts in Rack::Attack's Redis through the single counter (nextjs/src/server/controllers/rack-attack.ts) once a
# page, a redirect, a handler or a mutation answers them: discover, the storefront root, signup, /purchases, the ACME challenge, the Warden-user
# rules (totp confirm, passkeys, marketing execute) and the requests whose params Rack cannot parse. Each example sends a request from a
# non-local address (localhost is safelisted) and either reads the counters Rack::Attack wrote, or puts the first throttle at its limit and
# expects its 429. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/rack-attack-routes.replay.test.ts:
# an example named "counts ..." compares the keys, "answers 429 ..." the refusal, and "hands ..." must reach Rails whole and leave no count
# behind, because Rails counts it again.
describe "Counted routes", type: :request do
  include Parity::AudienceSignedIn

  let(:ip) { "203.0.113.88" }
  let(:ip_headers) { { "CF-Connecting-IP" => ip } }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let(:seller) { create(:user, name: "Counted Seller", username: "countedseller", created_at: Time.utc(2025, 1, 1)) }
  let(:redis) { Rack::Attack.cache.store }

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
    redis.flushdb
    Rack::Attack.reset!
  end

  after do
    redis.flushdb
    Rack::Attack.reset!
  end

  def counters = redis.keys("rack::attack:*").sort.to_h { |key| [key.sub(/\Arack::attack:\d+:/, ""), redis.get(key).to_i] }

  # The login, signup and settings rules exist only when Rails.env.production? (rack_attack.rb), which the initializer reads once at boot.
  def with_production_throttles
    registered = Rack::Attack.throttles.dup
    allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("production"))
    %i[GROUPED_RECEIPT_LOOKUP_PATHS PASSWORD_RESET_PATH].each { |name| Rack::Attack.send(:remove_const, name) }
    load Rails.root.join("config/initializers/rack_attack.rb")
    allow(Rails).to receive(:env).and_call_original
    redis.flushdb
    yield
  ensure
    Rack::Attack.throttles.replace(registered)
  end

  # Puts the first throttle of a request on its limit, as a client that has sent that many requests would.
  def fill(path, method:, limit:, host: DOMAIN, query: "")
    limit.times do
      env = Rack::MockRequest.env_for("http://#{host}#{path}", method:, "HTTP_CF_CONNECTING_IP" => ip)
      env["QUERY_STRING"] = query.delete_prefix("?")
      Rack::Attack.configuration.throttled?(Rack::Attack::Request.new(env))
    end
  end

  def expect_too_many_requests
    expect(response).to have_http_status(:too_many_requests)
    expect(response.body).to eq("Retry later\n")
    expect(response.headers["Retry-After"].to_i).to be_between(1, 64)
  end

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => csrf_token))
  end

  describe "GET /discover" do
    it "counts a page load in the five tiers of the address", parity: true do
      get "/discover", headers: ip_headers

      expect(response).to have_http_status(:ok)
      expect(counters.keys).to match_array(["/ip:/discover:#{ip}", *(2..5).map { |level| "/ip:/discover/#{level}:#{ip}" }])
      expect(counters.values.uniq).to eq([1])
    end

    it "answers 429 past sixty loads in thirty seconds", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/discover", method: "GET", limit: 60)

        get "/discover", headers: ip_headers
      end

      expect_too_many_requests
    end
  end

  describe "GET / on a seller host" do
    before { host! seller.subdomain }

    it "counts a storefront load in the root rule", parity: true do
      get "/", headers: ip_headers

      expect(response).to have_http_status(:ok)
      expect(counters.keys).to match_array(["/ip:/:#{ip}", *(2..5).map { |level| "/ip://#{level}:#{ip}" }])
    end

    it "answers 429 past sixty loads in thirty seconds", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/", method: "GET", limit: 60, host: seller.subdomain)

        get "/", headers: ip_headers
      end

      expect_too_many_requests
    end
  end

  describe "GET /signup" do
    it "counts a page load in the production signup rule", parity: true do
      with_production_throttles do
        get "/signup", headers: ip_headers

        expect(response).to have_http_status(:ok)
        expect(counters.keys).to match_array(["/ip:/signup:#{ip}", *(2..5).map { |level| "/ip:/signup/#{level}:#{ip}" }])
      end
    end

    it "answers 429 at the fourth page load in twenty seconds", parity: true do
      with_production_throttles do
        travel_to(Time.current.change(usec: 0)) do
          fill("/signup", method: "GET", limit: 3)

          get "/signup", headers: ip_headers
        end

        expect_too_many_requests
      end
    end
  end

  describe "GET /purchases" do
    it "counts the redirect in both purchases rules", parity: true do
      get "/purchases", headers: ip_headers

      expect(response).to have_http_status(:moved_permanently)
      expect(counters.keys).to match_array(["/ip:/purchases:#{ip}", "/ip/period:/purchases:#{ip}", *(2..5).map { |level| "/ip:/purchases/#{level}:#{ip}" }])
    end

    it "answers 429 past forty requests in a minute", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/purchases", method: "GET", limit: 40)

        get "/purchases", headers: ip_headers
      end

      expect_too_many_requests
    end
  end

  describe "GET /.well-known/acme-challenge/:token" do
    let(:custom_domain) { create(:custom_domain, user: seller) }
    let(:path) { "/.well-known/acme-challenge/#{"a" * 43}" }

    it "counts a challenge request per path", parity: true do
      get path, headers: ip_headers.merge("HOST" => custom_domain.domain)

      expect(response).to have_http_status(:not_found)
      expect(counters.values).to eq([1])
      expect(counters.keys.first).to eq("/ip/period:(?-mix:\\A\\/\\.well-known\\/acme-challenge\\/):#{path}:#{ip}")
    end

    it "answers 429 past 120 challenge requests in a minute", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill(path, method: "GET", limit: 120, host: custom_domain.domain)

        get path, headers: ip_headers.merge("HOST" => custom_domain.domain)
      end

      expect_too_many_requests
    end
  end

  describe "user rules" do
    let(:tiers) { ->(name) { [name, *(2..6).map { |level| "#{name}/#{level}" }] } }

    def user_counters(name) = tiers.call(name).map { |tier| "#{tier}:#{seller.id}" }

    # What the throttle writes for a request past its limit: the user's counter at the limit, in the window of the clock.
    def preload(name, limit)
      limit.times { Rack::Attack.cache.count("#{name}:#{seller.id}", 60) }
    end

    describe "POST /settings/totp/confirm" do
      let(:name) { "/params:/settings/totp/confirm:post" }

      it "counts a refusal in the six tiers of the user", parity: true do
        log_in(seller)

        send_json(:post, confirm_settings_totp_path, { code: "123456" })

        expect(response).to have_http_status(:unprocessable_entity)
        expect(counters.keys).to match_array(user_counters(name))
      end

      it "answers 429 past ten confirmations in a minute", parity: true do
        log_in(seller)
        travel_to(Time.current.change(usec: 0)) do
          preload(name, 10)

          send_json(:post, confirm_settings_totp_path, { code: "123456" })
        end

        expect_too_many_requests
      end
    end

    describe "POST /settings/passkeys" do
      let(:name) { "/params:/settings/passkeys:POST" }

      it "hands a registration without a pending challenge to Rails", parity: true do
        log_in(seller)

        send_json(:post, settings_passkeys_path, { nickname: "Laptop", id: "abc", rawId: "abc", type: "public-key" })

        expect(response).to have_http_status(:unprocessable_entity)
        expect(counters.keys).to match_array(user_counters(name))
      end

      it "answers 429 past ten registrations in a minute", parity: true do
        log_in(seller)
        travel_to(Time.current.change(usec: 0)) do
          preload(name, 10)

          send_json(:post, settings_passkeys_path, { nickname: "Laptop", id: "abc", rawId: "abc", type: "public-key" })
        end

        expect_too_many_requests
      end
    end

    describe "POST /settings/passkeys/registration_options" do
      let(:name) { "/params:/settings/passkeys/registration_options:POST" }

      it "counts a request in the six tiers of the user", parity: true do
        create_list(:webauthn_credential, WebauthnCredential::MAX_PER_USER, user: seller)
        log_in(seller)

        send_json(:post, registration_options_settings_passkeys_path)

        expect(response).to have_http_status(:unprocessable_entity)
        expect(counters.keys).to match_array(user_counters(name))
      end
    end

    describe "POST /products/:product_id/marketing_actions/:id/execute.json" do
      let(:name) { "/params:/products/:id/marketing_actions/:id/execute:POST" }
      let(:product) { create(:product, user: seller, unique_permalink: "countme", created_at: Time.utc(2025, 1, 1)) }
      let(:action) { create(:marketing_action, user: seller, link: product, channel: "instagram", status: "approved", approved_at: Time.utc(2025, 3, 1), copy: "Hello") }
      let(:path) { "/products/#{product.unique_permalink}/marketing_actions/#{action.external_id}/execute.json" }

      before do
        create(:marketing_holdout_assignment, user: seller, marketing_holdout: false)
        Feature.activate_user(:auto_marketing, seller)
      end

      it "counts an execute in the six tiers of the user", parity: true do
        log_in(seller)

        send_json(:post, path)

        expect(response).to have_http_status(:unprocessable_entity)
        expect(counters.keys).to match_array(user_counters(name))
      end

      it "answers 429 past five executes in a minute", parity: true do
        log_in(seller)
        travel_to(Time.current.change(usec: 0)) do
          preload(name, 5)

          send_json(:post, path)
        end

        expect_too_many_requests
      end
    end
  end

  describe "a request whose params Rack cannot parse" do
    # Rack raises QueryLimitError past 31 nested brackets in a key; rack-test cannot send a malformed percent escape.
    let(:too_deep) { { a: 33.times.reduce("1") { |inner, _| { b: inner } } } }
    let(:query) { "?a#{"[b]" * 33}=1" }

    it "hands the request to Rails, which counts invalid params", parity: true do
      get "/discover", params: too_deep, headers: ip_headers

      expect(counters.keys).to include("invalid_params:/discover:#{ip}", "/ip:/discover:#{ip}")
      expect(counters.keys.grep(/\Ainvalid_params/).size).to eq(7)
    end

    it "answers 429 at the sixth request in a minute", parity: true do
      travel_to(Time.current.change(usec: 0)) do
        fill("/discover", method: "GET", limit: 5, query:)

        get "/discover", params: too_deep, headers: ip_headers
      end

      expect_too_many_requests
    end
  end
end
