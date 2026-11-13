# frozen_string_literal: true

require "spec_helper"

# The Stripe Connect callback of a signed-in seller (User::OmniauthCallbacksController#stripe_connect), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/stripe-connect-omniauth.replay.test.ts. Every provider answer is a WebMock stub
# (the token exchange, the strategy's account call, Stripe::Account.retrieve); the OmniAuth middleware runs for real (test_mode off). An
# example named "hands ..." is one Node leaves to Rails before Stripe's single-use code is spent: a visitor who is not signed in can only be
# judged (sign in, sign up or refuse) from the account the exchange returns.
describe "Stripe Connect callback", type: :request do
  include Parity::AudienceSignedIn

  let(:json) { { "Content-Type" => "application/json; charset=utf-8" } }
  let(:seller) { create(:named_seller, email: "stripe.seller@example.com") }
  let(:stripe_user_id) { "acct_1Connect42" }
  let(:access_token) { "sk_connect_access_token" }

  around do |example|
    previous = OmniAuth.config.test_mode
    OmniAuth.config.test_mode = false
    example.run
  ensure
    OmniAuth.config.test_mode = previous
  end

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  # OmniAuth keeps the query string of the request phase (not the form) as `omniauth.params`: the referer travels there.
  def begin_flow(referer: nil)
    post ["/users/auth/stripe_connect", ({ referer: }.to_query if referer)].compact.join("?"), params: { authenticity_token: csrf_token }
    expect(response).to have_http_status(:found)
  end

  def stub_stripe(country: "US", token_status: 200, token_body: nil, account_status: 200, retrieve_status: 200)
    token_body ||= { access_token:, livemode: false, refresh_token: "rt_connect", token_type: "bearer", stripe_publishable_key: "pk_test_connect",
                     stripe_user_id:, scope: "read_write" }
    stub_request(:post, "https://connect.stripe.com/oauth/token").to_return(status: token_status, headers: json, body: token_body.to_json)
    stub_request(:get, "https://api.stripe.com/v1/account").with(headers: { "Authorization" => "Bearer #{access_token}" })
      .to_return(status: account_status, headers: json, body: { id: stripe_user_id, email: "connected@example.com", business_name: "Connected Co", country: }.to_json)
    stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_user_id}")
      .to_return(status: retrieve_status, headers: json, body: { id: stripe_user_id, object: "account", country: }.to_json)
  end

  def callback(**params)
    get "/users/auth/stripe_connect/callback", params: { code: "stripe-code-1" }.merge(params)
  end

  def connect_as(user, flow: {}, **callback_params)
    log_in(user)
    begin_flow(**flow)
    callback(**callback_params)
  end

  describe "a signed-in seller" do
    it "is sent on to complete the connection", parity: true do
      stub_stripe

      connect_as(seller)

      expect(response).to redirect_to("/oauth_completions/stripe")
      expect(a_request(:post, "https://connect.stripe.com/oauth/token").with { |request| request.body.include?("code=stripe-code-1") }).to have_been_made.once
    end

    it "is sent back to the page the connection started from once it completes", parity: true do
      stub_stripe

      connect_as(seller, flow: { referer: "/settings/payments" })

      expect(response).to redirect_to("/oauth_completions/stripe")
    end

    it "is sent on whatever the state of the callback, as Stripe ignores it", parity: true do
      stub_stripe

      connect_as(seller, state: "anything")

      expect(response).to redirect_to("/oauth_completions/stripe")
    end

    it "is told about a Stripe account already connected", parity: true do
      create(:merchant_account_stripe_connect, user: seller)
      stub_stripe

      connect_as(seller, flow: { referer: "/settings/payments" })

      expect(response).to redirect_to("/settings/payments")
      expect(flash[:alert]).to eq("This seller already has another Stripe account connected with Gumroad.")
      expect(a_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_user_id}")).not_to have_been_made
    end

    it "is refused when Stripe reports a country Stripe Connect does not support, and sent back to the referer", parity: true do
      stub_stripe(country: "IN")

      connect_as(seller, flow: { referer: "/settings/payments" })

      expect(response).to redirect_to("/settings/payments")
      expect(flash[:alert]).to eq("Sorry, Stripe Connect is not supported in India yet.")
    end

    it "is refused for an unsupported country and sent home when the flow had no referer", parity: true do
      stub_stripe(country: "IN")

      connect_as(seller)

      expect(response).to redirect_to("/")
      expect(flash[:alert]).to eq("Sorry, Stripe Connect is not supported in India yet.")
    end

    it "is refused for an unsupported country with a referer pointing off the site", parity: true do
      stub_stripe(country: "IN")

      connect_as(seller, flow: { referer: "https://evil.example.org/path?x=1" })

      expect(response).to redirect_to("/path?x=1")
    end

    it "is refused for a country Stripe reports that Gumroad has no name for", parity: true do
      stub_stripe(country: "ZZ")

      connect_as(seller, flow: { referer: "/settings/payments" })

      expect(response).to redirect_to("/settings/payments")
      expect(flash[:alert]).to eq("Sorry, Stripe Connect is not supported in  yet.")
    end

    it "is the team member's seller account that is connected when a member switched to it", parity: true do
      team_member = create(:user)
      membership = create(:team_membership, user: team_member, seller:, role: TeamMembership::ROLE_ADMIN)
      log_in(team_member)
      switch_to(membership)
      begin_flow(referer: "/settings/payments")
      stub_stripe

      callback

      expect(response).to redirect_to("/oauth_completions/stripe")
    end

    it "is told the connection failed when Stripe refuses the code", parity: true do
      stub_stripe(token_status: 400, token_body: { error: "invalid_grant", error_description: "Authorization code does not exist" })

      connect_as(seller)

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "ends in the failure action when the token answer carries no access token", parity: true do
      stub_stripe(token_body: { livemode: false })

      connect_as(seller)

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "ends in the failure action when the account call is refused", parity: true do
      stub_stripe(account_status: 401)

      connect_as(seller)

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end
  end

  describe "a callback Node leaves to Rails" do
    it "hands a callback of a visitor who is not signed in to Rails", parity: true do
      begin_flow
      stub_stripe

      callback

      expect(response).to have_http_status(:found)
    end

    it "hands an XHR callback to Rails", parity: true do
      log_in(seller)
      begin_flow
      stub_stripe

      get "/users/auth/stripe_connect/callback", params: { code: "stripe-code-1" }, headers: { "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to have_http_status(:found)
    end

    it "hands a callback without a code to Rails", parity: true do
      log_in(seller)
      begin_flow
      stub_stripe

      get "/users/auth/stripe_connect/callback"

      expect(response).to have_http_status(:found)
    end
  end
end
