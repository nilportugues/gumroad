# frozen_string_literal: true

require "spec_helper"

# Oauth::MobilePreAuthorizationsController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws10-triage.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one
# Node leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "Mobile pre-authorization", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:named_user, name: "Mobile Visitor") }
  let(:query) { { client_id: "mobile-client", redirect_uri: "gumroad://callback", response_type: "code", state: "a b" } }

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  describe "GET /oauth/mobile_pre_authorization/new" do
    # the cookie is secure, which a plain HTTP request is not given
    before { https! }

    it "marks the browser as the mobile app and sends a signed-out visitor to authorize", parity: true do
      get "/oauth/mobile_pre_authorization/new", params: query

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("https://#{DOMAIN}/oauth/authorize?#{query.to_query}")
    end

    it "keeps the question mark of an empty query string", parity: true do
      get "/oauth/mobile_pre_authorization/new"

      expect(response.location).to eq("https://#{DOMAIN}/oauth/authorize?")
    end

    it "hands the account chooser of a signed-in visitor to Rails", parity: true do
      log_in(user)

      get "/oauth/mobile_pre_authorization/new", params: query

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /oauth/mobile_pre_authorization/switch_account" do
    it "sends a signed-out visitor to authorize with the query string", parity: true do
      get "/oauth/mobile_pre_authorization/switch_account", params: query

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/oauth/authorize?#{query.to_query}")
    end

    it "keeps the question mark of an empty query string", parity: true do
      get "/oauth/mobile_pre_authorization/switch_account"

      expect(response.location).to eq("http://#{DOMAIN}/oauth/authorize?")
    end

    it "hands the sign-out of a signed-in visitor to Rails", parity: true do
      log_in(user)

      get "/oauth/mobile_pre_authorization/switch_account", params: query

      expect(response).to have_http_status(:found)
    end
  end
end
