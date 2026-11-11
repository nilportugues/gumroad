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

  it "does not count a request from localhost", parity: true do
    token = csrf_token
    5.times do
      post "/users/forgot_password", params: { authenticity_token: token, user: { email: "nobody@example.com" } }
      expect(response).not_to have_http_status(:too_many_requests)
    end
  end
end
