# frozen_string_literal: true

require "spec_helper"

# GET /integrations/discord/oauth_redirect when the state names no seller to redirect to: an empty page in the `application` layout,
# 400 without a `code` key. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/integrations-discord-oauth-redirect-page.replay.test.ts, which masks the per-request CSRF token and CSP nonce.
# The redirects and 404s of the same action are in integrations_discord_parity_spec.rb. "hands a ..." is an example Node leaves to Rails.
describe "Integrations::DiscordController oauth_redirect page", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  def redirect(**params)
    get oauth_redirect_integrations_discord_index_path, params:
  end

  it "renders the empty layout for a code without a state", parity: true do
    redirect(code: "test_code")

    expect(response).to have_http_status(:ok)
    expect(response.body).to include('<div class="flex-1 flex flex-col">')
  end

  it "answers 400 in the same layout when the request has no code", parity: true do
    redirect

    expect(response).to have_http_status(:bad_request)
    expect(response.body).to include("design-settings")
  end

  it "renders the page for a state that is not a JSON object", parity: true do
    redirect(code: "test_code", state: "123")

    expect(response).to have_http_status(:ok)
  end

  it "answers 400 for a state without a seller id", parity: true do
    redirect(state: { is_custom_domain: false }.to_json)

    expect(response).to have_http_status(:bad_request)
  end

  it "renders the page for a blank seller id", parity: true do
    redirect(code: "test_code", state: { seller_id: "  " }.to_json)

    expect(response).to have_http_status(:ok)
  end

  it "answers 400 for a seller id that is not text", parity: true do
    redirect(state: { seller_id: 12 }.to_json)

    expect(response).to have_http_status(:bad_request)
  end

  it "renders the page for a signed-in seller", parity: true do
    log_in(create(:user))

    redirect(code: "test_code", state: "123")

    expect(response).to have_http_status(:ok)
  end

  it "hands a request that asks for JSON to Rails", parity: true do
    get oauth_redirect_integrations_discord_index_path, params: { code: "test_code" }, headers: { "Accept" => "application/json" }

    expect(response.status).to be < 500
  end

  it "hands a request from the Inertia client to Rails", parity: true do
    get oauth_redirect_integrations_discord_index_path, params: { code: "test_code" }, headers: { "X-Inertia" => "true" }

    expect(response.status).to be < 500
  end

  it "hands a request on a seller's subdomain to Rails", parity: true do
    seller = create(:user, username: "discordseller")
    host! seller.subdomain

    redirect(code: "test_code")

    expect(response.status).to be < 500
  end
end
