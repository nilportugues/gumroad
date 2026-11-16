# frozen_string_literal: true

require "spec_helper"

# Tokens the Next.js port issued at POST /oauth/token (nextjs/src/server/controllers/oauth-tokens.ts, replayed by
# nextjs/parity/__tests__/oauth-token-issuance.replay.test.ts, which writes the file below) must work in Rails exactly as the ones
# Doorkeeper issued: Rails finds them, authenticates API requests with them and redeems their refresh tokens. The rows are inserted
# as Node wrote them, bypassing the model, so Rails never generates a value itself.
describe "OAuth tokens issued by Node", type: :request do
  let(:golden) { JSON.parse(Rails.root.join("spec/support/fixtures/oauth_tokens_node.json").read).fetch("tokens") }
  let(:owner) { create(:user) }
  let(:resource_owner) { create(:user) }
  let(:application) { create(:oauth_application, owner:, confidential: false, scopes: "view_profile edit_products") }

  before { host! DOMAIN }

  def insert_node_token(entry, resource_owner_id: resource_owner.id)
    Doorkeeper::AccessToken.insert_all!([{
      resource_owner_id: entry["has_owner"] ? resource_owner_id : nil,
      application_id: application.id,
      token: entry.fetch("access_token"),
      refresh_token: entry["refresh_token"],
      expires_in: entry["expires_in"],
      scopes: entry.fetch("scopes"),
      resource: entry["resource"],
      created_at: Time.current.change(usec: 0)
    }])
    Doorkeeper::AccessToken.find_by!(token: entry.fetch("access_token"))
  end

  it "has an entry for each grant type" do
    expect(golden.map { |entry| entry["grant_type"] }.uniq).to match_array(%w[authorization_code client_credentials refresh_token])
  end

  it "writes tokens in the shape of SecureRandom.urlsafe_base64(32)" do
    rails_shape = SecureRandom.urlsafe_base64(32)

    golden.each do |entry|
      [entry["access_token"], entry["refresh_token"]].compact.each do |value|
        expect(value.length).to eq(rails_shape.length)
        expect(value).to match(/\A[A-Za-z0-9_-]+\z/)
      end
    end
  end

  it "finds every Node access token and refresh token with Doorkeeper's own lookups" do
    golden.each do |entry|
      token = insert_node_token(entry)

      expect(Doorkeeper::AccessToken.by_token(entry["access_token"])).to eq(token)
      expect(Doorkeeper::AccessToken.by_refresh_token(entry["refresh_token"])).to eq(token) if entry["refresh_token"]
      expect(token).to be_accessible
      expect(token.scopes).to eq(Doorkeeper::OAuth::Scopes.from_string(entry["scopes"]))
      token.delete
    end
  end

  it "authenticates API requests with every Node access token that is not bound to a resource" do
    golden.reject { |entry| entry["resource"] || !entry["has_owner"] }.each do |entry|
      insert_node_token(entry)
      path = entry["scopes"].split.include?("view_profile") ? "/api/v2/user" : "/api/v2/products"

      get path, headers: { "Authorization" => "Bearer #{entry["access_token"]}" }

      expect(response).to have_http_status(:ok), "#{entry["example"]}: #{response.body}"
      expect(response.parsed_body["success"]).to eq(true)
      Doorkeeper::AccessToken.where(token: entry["access_token"]).delete_all
    end
  end

  it "rejects a Node access token once Rails revokes it" do
    entry = golden.find { |candidate| candidate["has_owner"] && candidate["resource"].nil? && candidate["scopes"].split.include?("view_profile") }
    token = insert_node_token(entry)
    token.revoke

    get "/api/v2/user", headers: { "Authorization" => "Bearer #{entry["access_token"]}" }

    expect(response).to have_http_status(:unauthorized)
  end

  it "redeems the refresh token of every Node token that has one, revoking the Node row" do
    golden.select { |entry| entry["refresh_token"] && entry["resource"].nil? }.each do |entry|
      old = insert_node_token(entry)

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: entry["refresh_token"], client_id: application.uid }

      expect(response).to have_http_status(:ok), "#{entry["example"]}: #{response.body}"
      expect(old.reload.revoked_at).to be_present
      expect(response.parsed_body["scope"]).to eq(entry["scopes"])
      Doorkeeper::AccessToken.where(application_id: application.id).delete_all
    end
  end
end
