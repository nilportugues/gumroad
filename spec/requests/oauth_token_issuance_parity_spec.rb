# frozen_string_literal: true

require "spec_helper"

# Token issuance at POST /oauth/token and its aliases (authorization_code, client_credentials, refresh_token), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/oauth-token-issuance.replay.test.ts. The tokens are random, so the
# replay ignores them and checks their format and that the response carries what the new row stores; the rows Node writes also feed
# spec/requests/oauth_node_issued_tokens_spec.rb. An example named "hands ..." is one Node leaves to Rails.
describe "OAuth token issuance", type: :request do
  let(:owner) { create(:user) }
  let(:resource_owner) { create(:user) }
  let(:public_app) { create(:oauth_application, owner:, confidential: false, scopes: "view_profile edit_products") }
  let(:confidential_app) { create(:oauth_application, owner:, confidential: true, scopes: "view_profile edit_products") }
  let(:dynamic_app) { create(:oauth_application, owner:, confidential: false, mcp_dynamic_client: true, scopes: "view_profile edit_products") }
  let(:code_verifier) { "a-code-verifier-that-is-long-enough-for-pkce-0123456789" }
  let(:s256_challenge) { Base64.urlsafe_encode64(Digest::SHA256.digest(code_verifier), padding: false) }
  let(:mcp_resource) { "#{Mcp::DynamicClientOauth.base_url}/claude/v1/mcp" }

  before { host! DOMAIN }

  def basic(application)
    { "Authorization" => ActionController::HttpAuthentication::Basic.encode_credentials(application.uid, application.secret) }
  end

  def grant_for(application, **attributes)
    Doorkeeper::AccessGrant.create!(application:, resource_owner_id: resource_owner.id, redirect_uri: application.redirect_uri, expires_in: 600, scopes: "view_profile", **attributes)
  end

  def token_for(application, **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: resource_owner.id, scopes: "view_profile edit_products", use_refresh_token: true, **attributes)
  end

  def exchange(application, grant, **extra)
    post "/oauth/token", params: { grant_type: "authorization_code", code: grant.token, client_id: application.uid, redirect_uri: application.redirect_uri, **extra }
  end

  describe "authorization_code" do
    it "issues an access token and a refresh token for a code", parity: true do
      grant = grant_for(public_app)

      exchange(public_app, grant)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.keys).to match_array(%w[access_token token_type refresh_token scope created_at])
      expect(response.parsed_body).to include("token_type" => "Bearer", "scope" => "view_profile")
      expect(grant.reload.revoked_at).to be_present
      token = Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"])
      expect(token).to have_attributes(application_id: public_app.id, resource_owner_id: resource_owner.id, scopes: Doorkeeper::OAuth::Scopes.from_string("view_profile"), expires_in: nil, refresh_token: response.parsed_body["refresh_token"])
    end

    it "issues a token to a confidential client that sends its secret in a Basic header", parity: true do
      grant = grant_for(confidential_app, scopes: "view_profile edit_products")

      post "/oauth/token", params: { grant_type: "authorization_code", code: grant.token, redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["scope"]).to eq("view_profile edit_products")
    end

    it "issues a token to a confidential client that sends its secret as a parameter", parity: true do
      grant = grant_for(confidential_app)

      exchange(confidential_app, grant, client_secret: confidential_app.secret)

      expect(response).to have_http_status(:ok)
    end

    it "normalises the scopes of the code the way the token model does", parity: true do
      grant = grant_for(public_app, scopes: "view_profile  edit_products view_profile")

      exchange(public_app, grant)

      expect(response.parsed_body["scope"]).to eq("view_profile edit_products")
    end

    it "issues a token for a code with an S256 challenge and its verifier", parity: true do
      grant = grant_for(public_app, code_challenge: s256_challenge, code_challenge_method: "S256")

      exchange(public_app, grant, code_verifier:)

      expect(response).to have_http_status(:ok)
    end

    it "issues a token for a code with a plain challenge and its verifier", parity: true do
      grant = grant_for(public_app, code_challenge: code_verifier, code_challenge_method: "plain")

      exchange(public_app, grant, code_verifier:)

      expect(response).to have_http_status(:ok)
    end

    it "answers invalid_grant for a verifier that does not match an S256 challenge", parity: true do
      grant = grant_for(public_app, code_challenge: s256_challenge, code_challenge_method: "S256")

      exchange(public_app, grant, code_verifier: "another-verifier")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_grant")
      expect(Doorkeeper::AccessToken.count).to eq(0)
      expect(grant.reload.revoked_at).to be_nil
    end

    it "answers invalid_grant for a verifier that does not match a plain challenge", parity: true do
      grant = grant_for(public_app, code_challenge: code_verifier, code_challenge_method: "plain")

      exchange(public_app, grant, code_verifier: "another-verifier")

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a verifier sent with a code that has no challenge", parity: true do
      grant = grant_for(public_app)

      exchange(public_app, grant, code_verifier:)

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a challenge with a method Doorkeeper does not know", parity: true do
      grant = grant_for(public_app, code_challenge: code_verifier, code_challenge_method: "other")

      exchange(public_app, grant, code_verifier:)

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a redirect URI that is not the one of the code", parity: true do
      grant = grant_for(public_app)

      exchange(public_app, grant, redirect_uri: "https://elsewhere.example.com/callback")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_grant")
      expect(Doorkeeper::AccessToken.count).to eq(0)
    end

    it "answers invalid_grant for a code that was already redeemed", parity: true do
      grant = grant_for(public_app)
      exchange(public_app, grant)
      expect(response).to have_http_status(:ok)

      exchange(public_app, grant)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_grant")
      expect(Doorkeeper::AccessToken.count).to eq(1)
    end

    it "copies the resource of the code onto the token", parity: true do
      grant = grant_for(public_app, resource: "https://api.example.com/mcp")

      exchange(public_app, grant)

      expect(Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"]).resource).to eq("https://api.example.com/mcp")
    end

    it "issues a token on the ifttt alias", parity: true do
      grant = grant_for(public_app)

      post "/ifttt/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["token_type"]).to eq("Bearer")
    end

    it "issues a token on the notion alias", parity: true do
      grant = grant_for(confidential_app)

      post "/notion/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
    end

    %w[muse claude chatgpt].each do |client|
      it "issues a token on the #{client} alias", parity: true do
        grant = grant_for(public_app)

        post "/#{client}/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: public_app.uid, redirect_uri: public_app.redirect_uri }

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["token_type"]).to eq("Bearer")
      end
    end

    it "issues a token to a dynamically registered client that proves S256 PKCE for its resource", parity: true do
      grant = grant_for(dynamic_app, resource: mcp_resource, code_challenge: s256_challenge, code_challenge_method: "S256")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri, code_verifier:, resource: mcp_resource }

      expect(response).to have_http_status(:ok)
      expect(Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"]).resource).to eq(mcp_resource)
    end

    it "issues a token to a dynamically registered client that omits the resource parameter", parity: true do
      grant = grant_for(dynamic_app, resource: mcp_resource, code_challenge: s256_challenge, code_challenge_method: "S256")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri, code_verifier: }

      expect(response).to have_http_status(:ok)
    end

    it "refuses a dynamically registered client whose code has no S256 challenge", parity: true do
      grant = grant_for(dynamic_app, resource: mcp_resource, code_challenge: code_verifier, code_challenge_method: "plain")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri, code_verifier: }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_grant", "error_description" => "authorization code was not issued with an S256 code challenge")
    end

    it "refuses a dynamically registered client that sends no verifier", parity: true do
      grant = grant_for(dynamic_app, resource: mcp_resource, code_challenge: s256_challenge, code_challenge_method: "S256")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri }

      expect(response.parsed_body).to eq("error" => "invalid_request", "error_description" => "code_verifier is required")
    end

    it "refuses a dynamically registered client whose code has no bound resource", parity: true do
      grant = grant_for(dynamic_app, code_challenge: s256_challenge, code_challenge_method: "S256")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri, code_verifier: }

      expect(response.parsed_body).to eq("error" => "invalid_grant", "error_description" => "authorization code has no bound resource")
    end

    it "refuses a dynamically registered client that names another resource", parity: true do
      grant = grant_for(dynamic_app, resource: mcp_resource, code_challenge: s256_challenge, code_challenge_method: "S256")

      post "/claude/v1/oauth2/token", params: { grant_type: "authorization_code", code: grant.token, client_id: dynamic_app.uid, redirect_uri: dynamic_app.redirect_uri, code_verifier:, resource: "https://other.example.com/mcp" }

      expect(response.parsed_body).to eq("error" => "invalid_target", "error_description" => "resource does not match the authorization request")
    end
  end

  describe "a request that sends back the session cookie of an earlier response" do
    before { post "/oauth/token", params: { grant_type: "client_credentials", client_id: "unknown" } }

    it "issues a client_credentials token", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", scope: "view_profile" }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
    end

    it "answers a failing code exchange", parity: true do
      post "/oauth/token", params: { grant_type: "authorization_code", code: "unknown", redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "on the API host" do
    before { host! API_DOMAIN }

    it "issues a client_credentials token", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", scope: "view_profile" }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
    end

    it "exchanges an authorization code", parity: true do
      grant = grant_for(confidential_app)

      post "/oauth/token", params: { grant_type: "authorization_code", code: grant.token, redirect_uri: confidential_app.redirect_uri }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "client_credentials" do
    it "issues an access token with no refresh token and no owner", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "view_profile" }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.keys).to match_array(%w[access_token token_type scope created_at])
      expect(response.parsed_body).to include("scope" => "view_profile")
      token = Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"])
      expect(token).to have_attributes(application_id: confidential_app.id, resource_owner_id: nil, refresh_token: nil, expires_in: nil)
    end

    it "issues a token to a client that sends its secret in a Basic header", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", scope: "view_profile edit_products" }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["scope"]).to eq("view_profile edit_products")
    end

    it "issues a token to a public client", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: public_app.uid, scope: "view_profile" }

      expect(response).to have_http_status(:ok)
    end

    it "issues a token on the ifttt alias", parity: true do
      post "/ifttt/v1/oauth2/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "edit_products" }

      expect(response).to have_http_status(:ok)
    end

    it "issues a new token on every request", parity: true do
      token_for(confidential_app, resource_owner_id: nil, use_refresh_token: false)

      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "view_profile edit_products" }

      expect(response).to have_http_status(:ok)
      expect(Doorkeeper::AccessToken.where(application_id: confidential_app.id, revoked_at: nil).count).to eq(2)
    end

    it "answers invalid_scope for a scope the application lacks", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "view_sales" }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_scope", "error_description" => "The requested scope is invalid, unknown, or malformed.")
      expect(response.headers["WWW-Authenticate"]).to start_with("Bearer realm=\"Doorkeeper\", error=\"invalid_scope\"")
      expect(Doorkeeper::AccessToken.count).to eq(0)
    end

    it "answers invalid_scope when no scope is asked for", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret }

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end

    it "answers invalid_scope for a scope list with one scope the application lacks", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "view_profile view_sales" }

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end

    it "validates the normalised scope, so a tab between two scopes is a separator", parity: true do
      post "/oauth/token", params: { grant_type: "client_credentials", client_id: confidential_app.uid, client_secret: confidential_app.secret, scope: "view_profile\tedit_products" }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["scope"]).to eq("view_profile edit_products")
    end
  end

  describe "refresh_token" do
    it "issues a new token, keeps the scopes and revokes the old row", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.keys).to match_array(%w[access_token token_type refresh_token scope created_at])
      expect(response.parsed_body).to include("scope" => "view_profile edit_products")
      expect(old.reload.revoked_at).to be_present
      fresh = Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"])
      expect(fresh).to have_attributes(application_id: public_app.id, resource_owner_id: resource_owner.id, expires_in: nil, refresh_token: response.parsed_body["refresh_token"])
      expect(fresh.refresh_token).not_to eq(old.refresh_token)
    end

    it "issues a token to a confidential client that authenticates with a Basic header", parity: true do
      old = token_for(confidential_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token }, headers: basic(confidential_app)

      expect(response).to have_http_status(:ok)
    end

    it "narrows the scopes to the ones asked for", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid, scope: "view_profile" }

      expect(response.parsed_body["scope"]).to eq("view_profile")
    end

    it "reads the narrower scopes from the scopes parameter", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid, scopes: "edit_products" }

      expect(response.parsed_body["scope"]).to eq("edit_products")
    end

    it "keeps the lifetime of the old token", parity: true do
      old = token_for(public_app, expires_in: 7200)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["expires_in"]).to be_between(7190, 7200)
      expect(Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"]).expires_in).to eq(7200)
    end

    it "answers invalid_scope for a scope list containing a tab, which the raw string check refuses", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid, scope: "view_profile\tedit_products" }

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end

    it "answers invalid_scope for a scope the old token lacks", parity: true do
      old = token_for(public_app, scopes: "view_profile")

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid, scope: "edit_products" }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_scope")
      expect(old.reload.revoked_at).to be_nil
    end

    it "answers invalid_request when no refresh token is sent", parity: true do
      post "/oauth/token", params: { grant_type: "refresh_token", client_id: public_app.uid }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_request", "error_description" => "Missing required parameter: refresh_token.")
    end

    it "answers invalid_grant for a refresh token that does not exist", parity: true do
      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: "unknown", client_id: public_app.uid }

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_grant for a refresh token that was already used", parity: true do
      old = token_for(public_app)
      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }
      expect(response).to have_http_status(:ok)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
      expect(Doorkeeper::AccessToken.count).to eq(2)
    end

    it "answers invalid_grant for a refresh token of another application", parity: true do
      other = create(:oauth_application, owner:, confidential: false)
      old = token_for(other)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
      expect(old.reload.revoked_at).to be_nil
    end

    it "answers invalid_grant when no client credentials are sent", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token }

      expect(response.parsed_body["error"]).to eq("invalid_grant")
    end

    it "answers invalid_client for an unknown client", parity: true do
      old = token_for(public_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: "unknown" }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("invalid_client")
    end

    it "answers invalid_client for a confidential client with the wrong secret", parity: true do
      old = token_for(confidential_app)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: confidential_app.uid, client_secret: "wrong" }

      expect(response).to have_http_status(:unauthorized)
      expect(old.reload.revoked_at).to be_nil
    end

    it "copies the resource onto the new token", parity: true do
      old = token_for(public_app, resource: "https://api.example.com/mcp")

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }

      expect(Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"]).resource).to eq("https://api.example.com/mcp")
    end

    it "refreshes a dynamically registered client's token for its resource", parity: true do
      old = token_for(dynamic_app, resource: mcp_resource)

      post "/claude/v1/oauth2/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: dynamic_app.uid, resource: mcp_resource }

      expect(response).to have_http_status(:ok)
    end

    it "refuses a dynamically registered client's token with no bound resource", parity: true do
      old = token_for(dynamic_app)

      post "/claude/v1/oauth2/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: dynamic_app.uid }

      expect(response.parsed_body).to eq("error" => "invalid_grant", "error_description" => "refresh token has no bound resource")
    end

    it "refuses a dynamically registered client that names another resource", parity: true do
      old = token_for(dynamic_app, resource: mcp_resource)

      post "/claude/v1/oauth2/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: dynamic_app.uid, resource: "https://other.example.com/mcp" }

      expect(response.parsed_body).to eq("error" => "invalid_target", "error_description" => "resource does not match the refresh token")
    end

    describe "with a brand token" do
      let(:membership) { create(:team_membership, seller: resource_owner, user: owner, role: TeamMembership::ROLE_ADMIN) }
      let(:old) { token_for(public_app, team_membership_id: membership.id) }
      let(:inactive) { { "error" => "invalid_grant", "error_description" => "The team membership behind this token is no longer active" } }

      def refresh
        post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: old.refresh_token, client_id: public_app.uid }
      end

      it "refreshes it and keeps the team membership on the new token", parity: true do
        refresh

        expect(response).to have_http_status(:ok)
        fresh = Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"])
        expect(fresh.team_membership_id).to eq(membership.id)
        expect(old.reload).to be_revoked
      end

      it "refreshes it when the member's sessions were invalidated before the token was issued", parity: true do
        owner.update_columns(last_active_sessions_invalidated_at: 1.day.ago)

        refresh

        expect(response).to have_http_status(:ok)
      end

      it "refuses it once the membership is deleted", parity: true do
        membership.update_columns(deleted_at: Time.current)

        refresh

        expect(response).to have_http_status(:bad_request)
        expect(response.parsed_body).to eq(inactive)
        expect(old.reload).not_to be_revoked
      end

      it "refuses it for a membership that is not an admin one", parity: true do
        membership.update_columns(role: TeamMembership::ROLE_MARKETING)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end

      it "refuses it for a membership of another account", parity: true do
        membership.update_columns(seller_id: create(:user).id)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end

      it "refuses it once the account is deleted", parity: true do
        membership
        resource_owner.update_columns(deleted_at: Time.current)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end

      it "refuses it once the member is deleted", parity: true do
        membership
        owner.update_columns(deleted_at: Time.current)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end

      it "refuses it once the member's sessions were invalidated after the token was issued", parity: true do
        membership
        old
        owner.update_columns(last_active_sessions_invalidated_at: 1.hour.from_now)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end

      it "refuses a brand token whose membership no longer exists", parity: true do
        old.update_columns(team_membership_id: 999_999)

        refresh

        expect(response.parsed_body).to eq(inactive)
      end
    end
  end
end
