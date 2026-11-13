# frozen_string_literal: true

require "spec_helper"

# GET /integrations/zoom/oauth_redirect and /integrations/google_calendar/oauth_redirect (an empty page in the `application` layout,
# 400 without a `code` key) recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/integrations-oauth-redirect.replay.test.ts. The body carries a per-request CSRF token and CSP nonce, which the
# replay masks. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Integrations oauth_redirect pages", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  { "zoom" => :oauth_redirect_integrations_zoom_index_path, "google_calendar" => :oauth_redirect_integrations_google_calendar_index_path }.each do |provider, path_helper|
    describe "GET /integrations/#{provider}/oauth_redirect" do
      let(:path) { public_send(path_helper) }

      it "renders the empty layout for a visitor who returns with a code", parity: true do
        get path, params: { code: "test_code" }

        expect(response).to have_http_status(:ok)
        expect(response.body).to include('<div class="flex-1 flex flex-col">')
      end

      it "answers 400 in the same layout when the request has no code", parity: true do
        get path

        expect(response).to have_http_status(:bad_request)
        expect(response.body).to include("design-settings")
      end

      it "counts a bare code key as present", parity: true do
        get "#{path}?code"

        expect(response).to have_http_status(:ok)
      end

      it "counts an empty code as present", parity: true do
        get "#{path}?code="

        expect(response).to have_http_status(:ok)
      end

      it "counts a nested code as present", parity: true do
        get path, params: { code: { a: "1" } }

        expect(response).to have_http_status(:ok)
      end

      it "renders the page for a signed-in seller", parity: true do
        log_in(create(:user))

        get path, params: { code: "test_code", state: "ignored" }

        expect(response).to have_http_status(:ok)
      end

      it "shows the flash a stale confirmation link left behind", parity: true do
        get "/users/confirmation", params: { confirmation_token: "stale" }
        expect(response).to have_http_status(:found)

        get path, params: { code: "test_code" }

        expect(response.body).to include("This confirmation link is no longer valid.")
      end

      it "marks the body of a Mac visitor and honours as_embed", parity: true do
        get path, params: { code: "test_code", as_embed: "true" }, headers: { "User-Agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }

        expect(response.body).to include('class="group/body mac"')
        expect(response.body).to include("background: transparent")
      end

      it "hands a request that asks for JSON to Rails", parity: true do
        get path, params: { code: "test_code" }, headers: { "Accept" => "application/json" }

        expect(response.status).to be < 500
      end

      it "hands a request from the Inertia client to Rails", parity: true do
        get path, params: { code: "test_code" }, headers: { "X-Inertia" => "true" }

        expect(response.status).to be < 500
      end
    end
  end
end
