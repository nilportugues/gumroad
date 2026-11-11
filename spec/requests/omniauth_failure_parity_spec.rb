# frozen_string_literal: true

require "spec_helper"

# GET and POST /users/auth/failure (User::OmniauthCallbacksController#failure) as a request over HTTP, which carries no OmniAuth strategy,
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws10-triage.replay.test.ts, which sends the last
# request of each example. An example named "hands ..." is one Node leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "OmniAuth failure endpoint", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:named_user, name: "Failure Visitor") }

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  describe "GET" do
    it "sends a visitor with no failed strategy to the login page", parity: true do
      get "/users/auth/failure"

      expect(response).to redirect_to("http://#{DOMAIN}/login")
    end

    it "ignores the message and strategy of OmniAuth's redirect", parity: true do
      get "/users/auth/failure", params: { message: "invalid_credentials", strategy: "twitter" }

      expect(response).to redirect_to("http://#{DOMAIN}/login")
    end

    it "shows the error description of the provider on the payments settings page", parity: true do
      get "/users/auth/failure", params: { error: "access_denied", error_description: "The user denied access" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
      expect(flash[:notice]).to eq("The user denied access")
    end

    it "prefers the error description over the async Twitter link state", parity: true do
      get "/users/auth/failure", params: { state: "async_link_twitter_account", error_description: "Try again later" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
    end

    it "reads a blank error description as missing", parity: true do
      get "/users/auth/failure", params: { error_description: "   " }

      expect(response).to redirect_to("http://#{DOMAIN}/login")
    end

    it "sends a signed-in visitor to the login page as well", parity: true do
      log_in(user)

      get "/users/auth/failure"

      expect(response).to redirect_to("http://#{DOMAIN}/login")
    end

    it "hands the async Twitter link page to Rails", parity: true do
      get "/users/auth/failure", params: { state: "async_link_twitter_account" }

      expect(response).to have_http_status(:ok)
    end

    it "hands an error description that is not a string to Rails", parity: true do
      get "/users/auth/failure?error_description[]=first&error_description[]=second"

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
    end
  end

  describe "POST" do
    it "sends a visitor with no failed strategy to the login page", parity: true do
      post "/users/auth/failure", params: { authenticity_token: csrf_token }

      expect(response).to redirect_to("http://#{DOMAIN}/login")
    end

    it "shows the error description of the provider on the payments settings page", parity: true do
      post "/users/auth/failure", params: { authenticity_token: csrf_token, error_description: "Account not eligible" }

      expect(response).to redirect_to("http://#{DOMAIN}/settings/payments")
      expect(flash[:notice]).to eq("Account not eligible")
    end

    it "hands a post without an authenticity token to Rails", parity: true do
      post "/users/auth/failure", params: { error_description: "No token" }

      expect(response).to have_http_status(:found)
    end
  end
end
