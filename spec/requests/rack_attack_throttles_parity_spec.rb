# frozen_string_literal: true

require "spec_helper"

# The Rack::Attack throttles of routes Node serves (config/initializers/rack_attack.rb), tripped over HTTP and recorded for the Next.js port
# (PARITY_RECORD=1). nextjs/parity/__tests__/ws10-rest.replay.test.ts replays every request of an example in order against a Node that counts
# in its own Redis database: the request over the limit has to answer 429 with the same body, content type and Retry-After window.
# The client address comes from CF-Connecting-IP, as in production: requests from 127.0.0.1 are safelisted and never counted.
describe "Rack::Attack throttles", type: :request do
  include Parity::AudienceSignedIn

  let(:ip_headers) { { "CF-Connecting-IP" => "203.0.113.50" } }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let(:seller) { create(:named_seller, name: "Throttled Seller") }

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
    Rack::Attack.cache.store.flushdb
    Rack::Attack.reset!
  end

  after do
    Rack::Attack.cache.store.flushdb
    Rack::Attack.reset!
  end

  # The login, signup and settings rules are registered only when Rails.env.production? (rack_attack.rb). The initializer runs once at boot, so
  # the example loads it again with the environment stubbed as production and puts the throttles back afterwards.
  def with_production_throttles
    registered = Rack::Attack.throttles.dup
    allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("production"))
    %i[GROUPED_RECEIPT_LOOKUP_PATHS PASSWORD_RESET_PATH].each { |name| Rack::Attack.send(:remove_const, name) }
    load Rails.root.join("config/initializers/rack_attack.rb")
    allow(Rails).to receive(:env).and_call_original
    Rack::Attack.cache.store.flushdb
    yield
  ensure
    Rack::Attack.throttles.replace(registered)
  end

  def expect_throttled
    expect(response).to have_http_status(:too_many_requests)
    expect(response.body).to eq("Retry later\n")
    expect(response.headers["Retry-After"].to_i).to be_between(1, 64)
  end

  it "answers the fourth password reset request from an address with 429", parity: true do
    token = csrf_token
    3.times do
      post "/users/forgot_password", params: { authenticity_token: token, user: { email: "nobody@example.com" } }, headers: ip_headers
      expect(response).not_to have_http_status(:too_many_requests)
    end

    post "/users/forgot_password", params: { authenticity_token: token, user: { email: "nobody@example.com" } }, headers: ip_headers

    expect_throttled
  end

  it "counts the recipient of a password reset across addresses", parity: true do
    user = create(:user, email: "target@example.com")
    token = csrf_token
    4.times do |index|
      post "/users/forgot_password", params: { authenticity_token: token, user: { email: user.email } }, headers: { "CF-Connecting-IP" => "203.0.113.#{60 + index}" }
      expect(response).not_to have_http_status(:too_many_requests)
    end

    post "/users/forgot_password", params: { authenticity_token: token, user: { email: user.email } }, headers: { "CF-Connecting-IP" => "203.0.113.70" }

    expect_throttled
  end

  it "answers the third receipt resend from an address with 429", parity: true do
    token = csrf_token
    2.times do
      post "/purchases/nosuchpurchase/resend_receipt", params: {}.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)
      expect(response).to have_http_status(:not_found)
    end

    post "/purchases/nosuchpurchase/resend_receipt", params: {}.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)

    expect_throttled
  end

  it "answers the eleventh two-factor attempt for a user with 429", parity: true do
    user = create(:user)
    token = csrf_token
    10.times do
      post "/two-factor", params: { authenticity_token: token, token: "123456", user_id: user.encrypted_external_id }, headers: ip_headers
      expect(response).not_to have_http_status(:too_many_requests)
    end

    post "/two-factor", params: { authenticity_token: token, token: "123456", user_id: user.encrypted_external_id }, headers: ip_headers

    expect_throttled
  end

  it "answers the thirty-first landing products request of an address on one host with 429", parity: true do
    30.times do
      get "/#{seller.username}/landing/products", params: { offset: 0, limit: 10 }, headers: ip_headers
      expect(response).to have_http_status(:not_found)
    end

    get "/#{seller.username}/landing/products", params: { offset: 0, limit: 10 }, headers: ip_headers

    expect_throttled
  end

  # Node serves the comment and chat writes of a signed-in user only: a signed-out request goes to Rails whole.
  def settings_params(user)
    { user: { email: user.email, username: user.username, enable_payment_email: true, locale: "en", timezone: "Pacific Time (US & Canada)", currency_type: "usd",
              purchasing_power_parity_enabled: false, purchasing_power_parity_excluded_product_ids: [], product_level_support_emails: [],
              seller_refund_policy: { max_refund_period_in_days: 30, fine_print: "" } } }.to_json
  end

  def inertia_headers
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end

  def sign_in_and_get_token(on_host: DOMAIN)
    log_in(create(:user))
    token = csrf_token
    host! on_host
    token
  end

  it "answers the sixth comment on a post from an address with 429", parity: true do
    token = sign_in_and_get_token(on_host: seller.subdomain)
    5.times do
      post "/posts/nosuchpost/comments", params: { comment: { content: "Hello" } }.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)
      expect(response).not_to have_http_status(:too_many_requests)
    end

    post "/posts/nosuchpost/comments", params: { comment: { content: "Hello" } }.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)

    expect_throttled
  end

  it "answers the sixth comment edit on a post from an address with 429", parity: true do
    token = sign_in_and_get_token(on_host: seller.subdomain)
    5.times do
      put "/posts/nosuchpost/comments/nosuchcomment", params: { comment: { content: "Hello" } }.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)
      expect(response).not_to have_http_status(:too_many_requests)
    end

    put "/posts/nosuchpost/comments/nosuchcomment", params: { comment: { content: "Hello" } }.to_json, headers: json_headers.merge(ip_headers, "X-CSRF-Token" => token)

    expect_throttled
  end

  # Sixty recorded requests take most of the 60-second window, so the clock stays put.
  it "answers the sixty-first chat message of an address in one community with 429", parity: true do
    token = sign_in_and_get_token
    freeze_time do
      60.times do
        post "/communities/nosuchcommunity/chat_messages", params: { community_chat_message: { content: "Hello" } }.to_json, headers: inertia_headers.merge(ip_headers, "X-CSRF-Token" => token)
        expect(response).not_to have_http_status(:too_many_requests)
      end

      post "/communities/nosuchcommunity/chat_messages", params: { community_chat_message: { content: "Hello" } }.to_json, headers: inertia_headers.merge(ip_headers, "X-CSRF-Token" => token)

      expect_throttled
    end
  end

  # 300 recorded requests take longer than the 60-second window, so the clock stays put.
  it "answers the three-hundred-and-first product search of an address with 429", parity: true do
    freeze_time do
      300.times do
        get "/products/search", params: { user_id: "nosuchuser" }, headers: ip_headers
        expect(response).not_to have_http_status(:too_many_requests)
      end

      get "/products/search", params: { user_id: "nosuchuser" }, headers: ip_headers

      expect_throttled
    end
  end

  describe "production-only rules" do
    let(:login_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

    it "answers the fourth login attempt from an address with 429", parity: true do
      token = csrf_token
      with_production_throttles do
        3.times do
          post "/login", params: { authenticity_token: token, user: { login_identifier: "nobody@example.com", password: "whatever-1" } }, headers: ip_headers
          expect(response).to have_http_status(:see_other)
        end

        post "/login", params: { authenticity_token: token, user: { login_identifier: "nobody@example.com", password: "whatever-1" } }, headers: ip_headers

        expect_throttled
      end
    end

    it "answers the fourth settings save from an address with 429", parity: true do
      user = create(:user, password: "a-long-password-1")
      log_in(user)
      token = csrf_token
      headers = inertia_headers.merge(ip_headers, "X-CSRF-Token" => token, "Referer" => "http://#{DOMAIN}/settings")
      with_production_throttles do
        3.times do
          put "/settings", params: settings_params(user), headers: headers
          expect(response).not_to have_http_status(:too_many_requests)
        end

        put "/settings", params: settings_params(user), headers: headers

        expect_throttled
      end
    end
  end

  it "does not count a request from localhost", parity: true do
    token = csrf_token
    5.times do
      post "/users/forgot_password", params: { authenticity_token: token, user: { email: "nobody@example.com" } }
      expect(response).not_to have_http_status(:too_many_requests)
    end
  end
end
