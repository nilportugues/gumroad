# frozen_string_literal: true

require "spec_helper"

# The token, revoke and introspect endpoints of Oauth::TokensController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/oauth-tokens.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one
# Node leaves to Rails: the replay asserts it reached Rails and wrote nothing.
#
# POST /oauth/token and its aliases are served by Node as well: the token issuance examples live in oauth_token_issuance_parity_spec.rb,
# and Rack::Attack's `oauth_token/ip` counter is the single one in controllers/rack-attack.ts (its limit is exercised by
# rack-attack-throttles.test.ts: 3000 requests do not fit a recording).
describe "OAuth tokens", type: :request do
  let(:owner) { create(:user) }
  let(:resource_owner) { create(:user) }
  let(:public_app) { create(:oauth_application, owner:, confidential: false, scopes: "view_profile edit_products") }
  let(:confidential_app) { create(:oauth_application, owner:, confidential: true, scopes: "view_profile edit_products") }
  let(:other_app) { create(:oauth_application, owner:, confidential: true, scopes: "view_profile") }

  before { host! DOMAIN }

  def basic(application)
    { "Authorization" => ActionController::HttpAuthentication::Basic.encode_credentials(application.uid, application.secret) }
  end

  def access_token_for(application, **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: resource_owner.id, scopes: "view_profile", use_refresh_token: true, **attributes)
  end

  def grant_for(application, **attributes)
    Doorkeeper::AccessGrant.create!(application:, resource_owner_id: resource_owner.id, redirect_uri: application.redirect_uri, expires_in: 600, scopes: "view_profile", **attributes)
  end

  describe "POST /ifttt/v1/oauth2/token" do
    it "answers unsupported_grant_type for a grant the server does not offer", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "password", client_id: public_app.uid, username: "a", password: "b" }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("unsupported_grant_type")
    end

    it "echoes the state of a request for an unsupported grant", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "made_up", state: "abc 123", client_id: public_app.uid }

      expect(response.parsed_body).to include("error" => "unsupported_grant_type", "state" => "abc 123")
    end

    it "asks for the code when grant_type is blank", parity: true do
      post "/ifttt/v1/oauth2/token", params: { client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error_description"]).to eq("Missing required parameter: code.")
    end

    it "asks for the redirect URI of an authorization code exchange", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant_for(public_app).token, client_id: public_app.uid }

      expect(response.parsed_body["error_description"]).to eq("Missing required parameter: redirect_uri.")
    end

    it "asks for the code verifier of a code issued with a challenge", parity: true do
      grant = grant_for(public_app, code_challenge: "challenge", code_challenge_method: "S256")

      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error_description"]).to eq("Missing required parameter: code_verifier.")
    end

    it "answers invalid_client for an unknown client", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant_for(public_app).token, client_id: "unknown", redirect_uri: public_app.redirect_uri }

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to start_with("Bearer realm=\"Doorkeeper\", error=\"invalid_client\"")
    end

    it "answers invalid_client for a confidential client with the wrong secret", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant_for(confidential_app).token, client_id: confidential_app.uid, client_secret: "wrong", redirect_uri: confidential_app.redirect_uri }

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers invalid_client for a confidential client with no secret", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant_for(confidential_app).token, client_id: confidential_app.uid, redirect_uri: confidential_app.redirect_uri }

      expect(response).to have_http_status(:unauthorized)
    end

    it "reads the client from a Basic header", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "prefers the Basic header to client_id", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: "ignored", redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a code that does not exist", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a code granted to another application", parity: true do
      other_public = create(:oauth_application, owner:, confidential: false)

      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant_for(other_public).token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for an expired code", parity: true do
      grant = grant_for(public_app, created_at: 2.hours.ago)

      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a revoked code", parity: true do
      grant = grant_for(public_app, revoked_at: 1.minute.ago)

      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "accepts the parameters as a JSON body", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }.to_json, headers: { "Content-Type" => "application/json" }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "hands a client_id that is not a string back to Rails", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: [public_app.uid], redirect_uri: public_app.redirect_uri }.to_json, headers: { "Content-Type" => "application/json" }

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a Basic header that is not plain Base64 back to Rails", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", redirect_uri: public_app.redirect_uri }, headers: { "Authorization" => "Basic !!!!" }

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers invalid_client for a client_credentials grant from an unknown client", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "client_credentials", client_id: "unknown", client_secret: "secret" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("invalid_client")
    end

    it "answers invalid_client for a client_credentials grant with the wrong secret", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: "wrong" }

      expect(response.parsed_body["error"]).to eq("invalid_client")
    end

    it "answers unauthorized_client for a client_credentials grant from a dynamically registered client", parity: true do
      dynamic_app = create(:oauth_application, owner:, confidential: false, mcp_dynamic_client: true)

      post "/ifttt/v1/oauth2/token", params: { grant_type: "client_credentials", client_id: dynamic_app.uid }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("unauthorized_client")
    end

    it "answers the Notion token endpoint like the token endpoint", parity: true do
      post "/notion/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end
  end

  describe "POST /oauth/token and the muse, claude and chatgpt aliases" do
    it "answers a failing code exchange on /oauth/token", parity: true do
      post "/oauth/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers a failing code exchange on the muse alias", parity: true do
      post "/muse/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers a failing code exchange on the claude alias", parity: true do
      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers a failing code exchange on the chatgpt alias", parity: true do
      post "/chatgpt/v1/oauth2/token", params: { grant_type: "authorization_code", code: "unknown", client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

  end

  # A client that keeps the cookie of an earlier response sends back a session holding only its session id; the recording's last
  # exchange is the one that carries the cookie.
  describe "a request that sends back the session cookie of an earlier response" do
    before { get "/oauth/token/info" }

    it "revokes the token of a public client", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.token, client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(token.reload.revoked_at).to be_present
    end

    it "refuses a revocation from an unknown client", parity: true do
      post "/oauth/revoke", params: { token: access_token_for(public_app).token, client_id: "unknown" }

      expect(response).to have_http_status(:forbidden)
    end

    it "reports an active token to the client it was issued to", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(confidential_app).token }, headers: basic(confidential_app)

      expect(response.parsed_body).to include("active" => true)
    end

    it "answers invalid_request when the caller proves nothing", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(public_app).token }

      expect(response).to have_http_status(:bad_request)
    end

    it "answers invalid_token for an unknown bearer token", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer unknown" }

      expect(response).to have_http_status(:unauthorized)
    end
  end

  # `use_doorkeeper` is not behind a host constraint, so the same endpoints answer on the API host.
  describe "on the API host" do
    before { host! API_DOMAIN }

    it "answers a failing code exchange", parity: true do
      post "/oauth/token", params: { grant_type: "authorization_code", code: "unknown", redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response).to have_http_status(:bad_request)
    end

    it "revokes the token of a public client", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.token, client_id: public_app.uid }

      expect(token.reload.revoked_at).to be_present
    end

    it "reports an active token to the client it was issued to", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(confidential_app).token }, headers: basic(confidential_app)

      expect(response.parsed_body).to include("active" => true)
    end

    it "answers invalid_token for an unknown bearer token", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer unknown" }

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "POST /oauth/revoke" do
    it "refuses a request with no client", parity: true do
      post "/oauth/revoke", params: { token: access_token_for(public_app).token }

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("error" => "unauthorized_client", "error_description" => "You are not authorized to revoke this token")
    end

    it "refuses an unknown client", parity: true do
      post "/oauth/revoke", params: { token: access_token_for(public_app).token, client_id: "unknown" }

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a confidential client that sends no secret", parity: true do
      post "/oauth/revoke", params: { token: access_token_for(confidential_app).token, client_id: confidential_app.uid }

      expect(response).to have_http_status(:forbidden)
    end

    it "answers 200 for a token that does not exist", parity: true do
      post "/oauth/revoke", params: { token: "unknown", client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq({})
    end

    it "answers 200 when no token is sent", parity: true do
      post "/oauth/revoke", params: { client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
    end

    it "revokes the token of a public client", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.token, client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(token.reload.revoked_at).to be_present
    end

    it "revokes a token for a confidential client that authenticates with its secret", parity: true do
      token = access_token_for(confidential_app)

      post "/oauth/revoke", params: { token: token.token }, headers: basic(confidential_app)

      expect(token.reload.revoked_at).to be_present
    end

    it "revokes the token a refresh token belongs to", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.refresh_token, token_type_hint: "refresh_token", client_id: public_app.uid }

      expect(token.reload.revoked_at).to be_present
    end

    it "finds a refresh token without a hint", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.refresh_token, client_id: public_app.uid }

      expect(token.reload.revoked_at).to be_present
    end

    it "does not find an access token when the hint names refresh tokens", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.token, token_type_hint: "refresh_token", client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(token.reload.revoked_at).to be_nil
    end

    it "refuses a confidential client revoking another application's token", parity: true do
      token = access_token_for(other_app)

      post "/oauth/revoke", params: { token: token.token }, headers: basic(confidential_app)

      expect(response).to have_http_status(:forbidden)
      expect(token.reload.revoked_at).to be_nil
    end

    it "lets any authenticated client revoke the token of a public application", parity: true do
      token = access_token_for(public_app)

      post "/oauth/revoke", params: { token: token.token }, headers: basic(confidential_app)

      expect(token.reload.revoked_at).to be_present
    end

    it "leaves a token that is already revoked as it is", parity: true do
      token = access_token_for(public_app, revoked_at: 1.hour.ago)

      post "/oauth/revoke", params: { token: token.token, client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
    end

    it "leaves an expired token as it is", parity: true do
      token = access_token_for(public_app, expires_in: 60, created_at: 2.hours.ago)

      post "/oauth/revoke", params: { token: token.token, client_id: public_app.uid }

      expect(token.reload.revoked_at).to be_nil
    end

    it "hands a token that is not a string back to Rails", parity: true do
      post "/oauth/revoke", params: { token: { a: 1 }, client_id: public_app.uid }.to_json, headers: { "Content-Type" => "application/json" }

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST /oauth/introspect" do
    it "reports an active token to the client it was issued to", parity: true do
      token = access_token_for(confidential_app)

      post "/oauth/introspect", params: { token: token.token }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("active" => true, "scope" => "view_profile", "client_id" => confidential_app.uid, "token_type" => "Bearer", "exp" => 0)
    end

    it "reports the expiry of a token that expires", parity: true do
      token = access_token_for(confidential_app, expires_in: 7200)

      post "/oauth/introspect", params: { token: token.token }, headers: basic(confidential_app)

      expect(response.parsed_body["active"]).to be(true)
    end

    it "reports a refresh token as active", parity: true do
      token = access_token_for(confidential_app)

      post "/oauth/introspect", params: { token: token.refresh_token }, headers: basic(confidential_app)

      expect(response.parsed_body["active"]).to be(true)
    end

    it "reports a revoked token as inactive", parity: true do
      token = access_token_for(confidential_app, revoked_at: 1.hour.ago)

      post "/oauth/introspect", params: { token: token.token }, headers: basic(confidential_app)

      expect(response.parsed_body).to eq("active" => false)
    end

    it "reports an expired token as inactive", parity: true do
      token = access_token_for(confidential_app, expires_in: 60, created_at: 2.hours.ago)

      post "/oauth/introspect", params: { token: token.token }, headers: basic(confidential_app)

      expect(response.parsed_body).to eq("active" => false)
    end

    it "reports an unknown token as inactive", parity: true do
      post "/oauth/introspect", params: { token: "unknown" }, headers: basic(confidential_app)

      expect(response.parsed_body).to eq("active" => false)
    end

    it "reports another application's token as inactive", parity: true do
      token = access_token_for(other_app)

      post "/oauth/introspect", params: { token: token.token }, headers: basic(confidential_app)

      expect(response.parsed_body).to eq("active" => false)
    end

    it "answers invalid_client for the wrong secret", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(confidential_app).token, client_id: confidential_app.uid, client_secret: "wrong" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to include("invalid_client")
    end

    it "answers invalid_request when the caller proves nothing", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(confidential_app).token }

      expect(response).to have_http_status(:bad_request)
    end

    it "accepts a bearer token of the same application", parity: true do
      introspected = access_token_for(public_app)
      bearer = access_token_for(public_app)

      post "/oauth/introspect", params: { token: introspected.token }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response.parsed_body).to include("active" => true, "client_id" => public_app.uid)
    end

    it "accepts a bearer token sent as access_token", parity: true do
      introspected = access_token_for(public_app)
      bearer = access_token_for(public_app)

      post "/oauth/introspect", params: { token: introspected.token, access_token: bearer.token }

      expect(response.parsed_body["active"]).to be(true)
    end

    it "refuses a bearer token of another application", parity: true do
      introspected = access_token_for(public_app)
      bearer = access_token_for(other_app)

      post "/oauth/introspect", params: { token: introspected.token }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("invalid_token")
    end

    it "refuses a bearer token that introspects itself", parity: true do
      bearer = access_token_for(public_app)

      post "/oauth/introspect", params: { token: bearer.token }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a revoked bearer token", parity: true do
      bearer = access_token_for(public_app, revoked_at: 1.hour.ago)

      post "/oauth/introspect", params: { token: access_token_for(public_app).token }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response.parsed_body["error_description"]).to eq("The access token was revoked")
    end

    it "refuses an expired bearer token", parity: true do
      bearer = access_token_for(public_app, expires_in: 60, created_at: 2.hours.ago)

      post "/oauth/introspect", params: { token: access_token_for(public_app).token }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response.parsed_body["error_description"]).to eq("The access token expired")
    end

    it "answers invalid_request for an unknown bearer token", parity: true do
      post "/oauth/introspect", params: { token: access_token_for(public_app).token }, headers: { "Authorization" => "Bearer unknown" }

      expect(response).to have_http_status(:bad_request)
    end

    it "reports no token as inactive to an authorized bearer", parity: true do
      bearer = access_token_for(public_app)

      post "/oauth/introspect", params: { token: "unknown" }, headers: { "Authorization" => "Bearer #{bearer.token}" }

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "GET /oauth/token/info" do
    let(:invalid_token_body) { { "error" => "invalid_token", "error_description" => "The access token is invalid", "state" => "unauthorized" } }

    it "answers invalid_token when no token is sent", parity: true do
      get "/oauth/token/info"

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq(invalid_token_body)
      expect(response.headers["WWW-Authenticate"]).to eq('Bearer realm="Doorkeeper", error="invalid_token", error_description="The access token is invalid"')
    end

    it "answers invalid_token for an unknown bearer token", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer unknown" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq(invalid_token_body)
    end

    it "answers invalid_token for an unknown access_token param", parity: true do
      get "/oauth/token/info", params: { access_token: "unknown" }

      expect(response).to have_http_status(:unauthorized)
    end

    it "gives a revoked token the generic invalid_token description", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer #{access_token_for(public_app, revoked_at: 1.hour.ago).token}" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq(invalid_token_body)
    end

    it "gives an expired token the generic invalid_token description", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer #{access_token_for(public_app, expires_in: 60, created_at: 2.hours.ago).token}" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq(invalid_token_body)
    end

    it "hands an accessible token to Rails", parity: true do
      get "/oauth/token/info", headers: { "Authorization" => "Bearer #{access_token_for(public_app).token}" }

      expect(response).to be_successful
      expect(response.parsed_body).to include("resource_owner_id" => resource_owner.id, "scope" => ["view_profile"])
    end
  end
end
