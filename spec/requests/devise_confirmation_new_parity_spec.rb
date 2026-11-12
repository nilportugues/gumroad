# frozen_string_literal: true

require "spec_helper"

# GET /users/confirmation/new (Devise's resend form, in the `application` layout) recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/devise-confirmation-new.replay.test.ts. The body carries per-request CSRF tokens (the meta tag and
# one per form); the replay masks them. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Devise confirmation pages", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  describe "GET /users/confirmation/new" do
    it "renders the resend form for a visitor with no cookies", parity: true do
      get "/users/confirmation/new"

      expect(response).to be_successful
      expect(response.body).to include("Resend confirmation instructions")
    end

    it "renders the form for a visitor who already has a guid", parity: true do
      get "/users/confirmation/new", headers: { "Cookie" => "_gumroad_guid=abc123" }

      expect(response).to be_successful
      expect(response.headers["Set-Cookie"]).not_to include("_gumroad_guid")
    end

    it "renders the form for a signed-in seller", parity: true do
      log_in(create(:user))

      get "/users/confirmation/new"

      expect(response).to be_successful
      expect(response.body).to include("Resend confirmation instructions")
    end

    it "shows the flash a stale confirmation link left behind", parity: true do
      get "/users/confirmation", params: { confirmation_token: "stale" }
      expect(response).to have_http_status(:found)

      get "/users/confirmation/new"

      expect(response.body).to include("This confirmation link is no longer valid.")
    end

    it "renders the form whatever the query string says", parity: true do
      get "/users/confirmation/new", params: { ref: "mail", as_embed: "true" }

      expect(response).to be_successful
      expect(response.body).to include("background: transparent")
    end

    it "marks the body of a Mac visitor", parity: true do
      get "/users/confirmation/new", headers: { "User-Agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }

      expect(response.body).to include('class="group/body mac"')
    end

    it "hands a request that asks for JSON to Rails", parity: true do
      get "/users/confirmation/new", headers: { "Accept" => "application/json" }

      expect(response).not_to be_successful
    end

    it "hands a request from the Inertia client to Rails", parity: true do
      get "/users/confirmation/new", headers: { "X-Inertia" => "true" }

      expect(response.status).to be < 500
    end
  end
end
