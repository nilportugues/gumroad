# frozen_string_literal: true

require "spec_helper"

# How the API base controllers resolve an access token and check its scopes, through the full Rack
# stack on the API host. Recorded for the Next.js port (PARITY_RECORD=1) and replayed in process by
# nextjs/parity/__tests__/api-token-auth.replay.test.ts against nextjs/src/server/auth/api-token.ts.
# GET /v2/user takes any of the public read scopes (and `account`).
describe "API token authentication", type: :request do
  let(:seller) { create(:user) }
  let(:application) { create(:oauth_application, owner: create(:user)) }

  before { host! API_DOMAIN }

  def token_for(owner = seller, scopes: "view_public", **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: owner&.id, scopes:, **attributes)
  end

  it "refuses a request without a token", parity: true do
    get "/v2/user"

    expect(response).to have_http_status(:unauthorized)
    expect(response.headers["WWW-Authenticate"]).to include('error="invalid_token"')
  end

  it "refuses an unknown token", parity: true do
    get "/v2/user", headers: { "Authorization" => "Bearer nonsense" }

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses an expired token", parity: true do
    token = token_for(expires_in: 60, created_at: 2.hours.ago)

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:unauthorized)
    expect(response.headers["WWW-Authenticate"]).to include("expired")
  end

  it "refuses a revoked token", parity: true do
    token = token_for(revoked_at: 1.hour.ago)

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:unauthorized)
    expect(response.headers["WWW-Authenticate"]).to include("revoked")
  end

  it "forbids a token without a scope the endpoint accepts", parity: true do
    token = token_for(scopes: "edit_emails")

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:forbidden)
    expect(response.headers["WWW-Authenticate"]).to be_nil
  end

  it "lets a token with the account scope through", parity: true do
    token = token_for(scopes: "account")

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:ok)
  end

  it "accepts a token in the Authorization header", parity: true do
    token = token_for

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:ok)
  end

  it "accepts the Bearer scheme in any case", parity: true do
    token = token_for

    get "/v2/user", headers: { "Authorization" => "bearer #{token.token}" }

    expect(response).to have_http_status(:ok)
  end

  it "accepts a token in the access_token param", parity: true do
    get "/v2/user", params: { access_token: token_for.token }

    expect(response).to have_http_status(:ok)
  end

  it "accepts a token in the bearer_token param", parity: true do
    get "/v2/user", params: { bearer_token: token_for.token }

    expect(response).to have_http_status(:ok)
  end

  it "prefers the Authorization header over the params", parity: true do
    get "/v2/user", params: { access_token: "nonsense" }, headers: { "Authorization" => "Bearer #{token_for.token}" }

    expect(response).to have_http_status(:ok)
  end

  it "falls back to the params when the Authorization header carries nothing", parity: true do
    get "/v2/user", params: { access_token: token_for.token }, headers: { "Authorization" => "Bearer " }

    expect(response).to have_http_status(:ok)
  end

  it "refuses a token whose owner was deleted", parity: true do
    token = token_for
    seller.update_column(:deleted_at, Time.current)

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:unauthorized)
  end

  it "authenticates a brand token of a member who may still switch in, which carries no v2 scope", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    token = token_for(scopes: "mobile_api creator_api")
    token.update_column(:team_membership_id, membership.id)

    get "/v2/user", params: { access_token: token.token }

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a brand token whose membership was removed", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    token = token_for(scopes: "view_public")
    token.update_column(:team_membership_id, membership.id)
    membership.update_column(:deleted_at, Time.current)

    get "/v2/user", params: { access_token: token.token }

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a brand token for a membership that is not an admin's", parity: true do
    membership = create(:team_membership, user: create(:user), seller:, role: TeamMembership::ROLE_SUPPORT)
    token = token_for(scopes: "view_public")
    token.update_column(:team_membership_id, membership.id)

    get "/v2/user", params: { access_token: token.token }

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token bound to another resource", parity: true do
    token = token_for
    token.update_column(:resource, "#{PROTOCOL}://#{DOMAIN}/claude/v1/mcp")

    get "/v2/user", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:unauthorized)
  end

  it "answers an endpoint's own scope check with a 403 body even for an account token", parity: true do
    token = token_for(scopes: "account")

    get "/v2/user/profile_layout", headers: { "Authorization" => "Bearer #{token.token}" }

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body).to eq("success" => false, "message" => "This endpoint requires the view_profile scope.")
  end
end
