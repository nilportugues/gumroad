# frozen_string_literal: true

require "spec_helper"

# The OmniAuth phases of User::OmniauthCallbacksController that run before a provider is asked for a token (the passthru 404, the
# request phase of Google and Stripe Connect, the callback checks that end in the failure action), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/omniauth-phases.replay.test.ts, which sends the last request of each
# example. The OmniAuth middleware runs for real (test_mode off); provider HTTP is WebMock-stubbed and lands in the fixture's "http".
# An example named "hands ..." is one Node leaves to Rails: the authorization code is spent by the exchange, so the callback that
# reaches it can only be answered whole by Rails.
describe "OmniAuth phases", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:named_user, name: "Omniauth Visitor") }

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

  # The state OmniAuth put in the redirect to the provider, which the callback must send back.
  def begin_flow(provider, params = {})
    post "/users/auth/#{provider}", params: { authenticity_token: csrf_token }.merge(params)
    expect(response).to have_http_status(:found)
    Rack::Utils.parse_query(URI(response.location).query)["state"]
  end

  describe "GET /users/auth/:provider" do
    %w[twitter stripe_connect google_oauth2 youtube instagram tiktok apple].each do |provider|
      it "answers the passthru page of #{provider} with a 404", parity: true do
        get "/users/auth/#{provider}"

        expect(response).to have_http_status(:not_found)
        expect(response.body).to eq("Not found. Authentication passthru.")
      end
    end

    it "answers the passthru page to a signed-in visitor with a 404 as well", parity: true do
      log_in(user)

      get "/users/auth/google_oauth2"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /users/auth/:provider" do
    it "sends a visitor to Google with a state and the requested scope", parity: true do
      post "/users/auth/google_oauth2", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("https://accounts.google.com/o/oauth2/auth?")
    end

    it "keeps the Google prompt a visitor asked for and the origin of the page", parity: true do
      post "/users/auth/google_oauth2", params: { authenticity_token: csrf_token, prompt: "select_account", login_hint: "buyer@example.com", referer: "/library" },
                                        headers: { "Referer" => "http://#{DOMAIN}/login" }

      expect(response.location).to include("prompt=select_account")
    end

    it "sends a visitor to Stripe Connect with the parameters of the request", parity: true do
      post "/users/auth/stripe_connect", params: { authenticity_token: csrf_token, referer: "/settings/payments", stripe_landing: "login" }

      expect(response.location).to start_with("https://connect.stripe.com/oauth/authorize?")
    end

    it "sends a signed-in seller to Stripe Connect", parity: true do
      log_in(user)

      post "/users/auth/stripe_connect", params: { authenticity_token: csrf_token, referer: "/settings/payments" }

      expect(response.location).to start_with("https://connect.stripe.com/oauth/authorize?")
    end

    it "redirects a Google request with a wrong authenticity token to the sign-in page", parity: true do
      csrf_token
      post "/users/auth/google_oauth2", params: { authenticity_token: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Actioncontroller::invalidauthenticitytoken\".")
    end

    it "redirects a Stripe Connect request without an authenticity token to the sign-in page", parity: true do
      csrf_token
      post "/users/auth/stripe_connect"

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from StripeConnect because \"Actioncontroller::invalidauthenticitytoken\".")
    end

    it "redirects a request with an authenticity token that belongs to no session to the sign-in page", parity: true do
      post "/users/auth/google_oauth2", params: { authenticity_token: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end
  end

  describe "GET /users/auth/google_oauth2/callback" do
    it "ends a callback whose state is not the one that was sent in the failure action", parity: true do
      begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { code: "code-1", state: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Csrf detected\".")
    end

    it "ends a callback with no state in the failure action", parity: true do
      begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { code: "code-1" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "ends a callback that no request phase came before in the failure action", parity: true do
      get "/users/auth/google_oauth2/callback", params: { code: "code-1", state: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "tells a visitor who denied access that Google refused", parity: true do
      state = begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { error: "access_denied", state: }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Access denied\".")
    end

    it "prefers the reason of the provider to its error code", parity: true do
      state = begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { error: "access_denied", error_reason: "user_denied", state: }

      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"User denied\".")
    end

    it "sends a visitor to the payments settings with the error description of the provider", parity: true do
      state = begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { error: "access_denied", error_description: "The user denied access", state: }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
      expect(flash[:notice]).to eq("The user denied access")
    end

    it "checks the state ahead of the error of the provider", parity: true do
      begin_flow("google_oauth2")

      get "/users/auth/google_oauth2/callback", params: { error: "access_denied", state: "forged" }

      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Csrf detected\".")
    end
  end

  describe "GET /users/auth/stripe_connect/callback" do
    it "tells a visitor who denied access that Stripe refused", parity: true do
      begin_flow("stripe_connect")

      get "/users/auth/stripe_connect/callback", params: { error: "access_denied" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from StripeConnect because \"Access denied\".")
    end

    it "sends a seller to the payments settings with the error description of Stripe", parity: true do
      begin_flow("stripe_connect")

      get "/users/auth/stripe_connect/callback", params: { error: "access_denied", error_description: "The user denied your request" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
      expect(flash[:notice]).to eq("The user denied your request")
    end

    it "does not check the state of a callback that carries an error", parity: true do
      begin_flow("stripe_connect")

      get "/users/auth/stripe_connect/callback", params: { error: "invalid_scope", error_description: "Scope is not valid", state: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
    end

    it "ends an error callback of a signed-in seller in the failure action", parity: true do
      log_in(user)
      begin_flow("stripe_connect")

      get "/users/auth/stripe_connect/callback", params: { error: "access_denied" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end
  end

  # Devise routes `/users/auth/:provider/callback` to the same action for a form POST, and `protect_from_forgery` (null_session) applies to it:
  # without a valid authenticity token Rails runs the action with a session it never writes. Only a POST with a valid token is Node's.
  describe "POST /users/auth/:provider/callback" do
    it "ends a Google callback whose state is not the one that was sent in the failure action", parity: true do
      begin_flow("google_oauth2")

      post "/users/auth/google_oauth2/callback", params: { authenticity_token: csrf_token, code: "code-1", state: "forged" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Csrf detected\".")
    end

    it "tells a visitor who denied access that Google refused", parity: true do
      state = begin_flow("google_oauth2")

      post "/users/auth/google_oauth2/callback", params: { authenticity_token: csrf_token, error: "access_denied", state: }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Access denied\".")
    end

    it "sends a seller to the payments settings with the error description of Stripe", parity: true do
      begin_flow("stripe_connect")

      post "/users/auth/stripe_connect/callback", params: { authenticity_token: csrf_token, error: "access_denied", error_description: "The user denied your request" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
      expect(flash[:notice]).to eq("The user denied your request")
    end

    it "ends an error callback of a signed-in seller in the failure action", parity: true do
      log_in(user)
      begin_flow("stripe_connect")

      post "/users/auth/stripe_connect/callback", params: { authenticity_token: csrf_token, error: "access_denied" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "hands a Google callback without an authenticity token to Rails", parity: true do
      state = begin_flow("google_oauth2")

      post "/users/auth/google_oauth2/callback", params: { error: "access_denied", state: }

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end

    it "hands a Stripe Connect callback with a wrong authenticity token to Rails", parity: true do
      begin_flow("stripe_connect")

      post "/users/auth/stripe_connect/callback", params: { authenticity_token: "forged", error: "access_denied", error_description: "The user denied your request" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
    end

    it "hands a Google callback sent as JSON to Rails", parity: true do
      state = begin_flow("google_oauth2")

      post "/users/auth/google_oauth2/callback", params: { authenticity_token: csrf_token, error: "access_denied", state: }.to_json,
                                                 headers: { "Content-Type" => "application/json" }

      expect(response).to have_http_status(:found)
    end
  end
end
