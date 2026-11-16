# frozen_string_literal: true

require "spec_helper"

# Codes and tokens the Next.js port issued for the OAuth device flow (nextjs/src/server/controllers/oauth-device.ts and
# oauth-tokens.ts, replayed by nextjs/parity/__tests__/oauth-device-flow.replay.test.ts, which writes the file below) must work in
# Rails as the ones OauthDeviceAuthorization issued: Rails finds the row by either code, a Rails approval and poll turn it into a
# token, and the token Node issued authenticates API requests. The rows go in as Node wrote them, bypassing the model.
describe "OAuth device flow issued by Node", type: :request do
  let(:golden) { JSON.parse(Rails.root.join("spec/support/fixtures/oauth_device_flow_node.json").read) }
  let(:owner) { create(:user) }
  let(:resource_owner) { create(:user) }
  let(:application) { create(:oauth_application, owner:, confidential: false, scopes: "view_profile edit_products", device_authorization_enabled: true) }

  before { host! DOMAIN }

  def insert_node_code(entry)
    now = Time.current.change(usec: 0)
    OauthDeviceAuthorization.insert_all!([{
                                           oauth_application_id: application.id,
                                           device_code_digest: entry.fetch("device_code_digest"),
                                           user_code_digest: entry.fetch("user_code_digest"),
                                           scopes: entry.fetch("scopes"),
                                           status: OauthDeviceAuthorization::STATUS_PENDING,
                                           expires_at: now + OauthDeviceAuthorization::EXPIRES_IN,
                                           poll_interval_seconds: entry.fetch("poll_interval_seconds"),
                                           created_at: now,
                                           updated_at: now
                                         }])
    OauthDeviceAuthorization.find_by!(device_code_digest: entry.fetch("device_code_digest"))
  end

  it "has codes and tokens to prove" do
    expect(golden.fetch("codes")).not_to be_empty
    expect(golden.fetch("tokens")).not_to be_empty
  end

  it "writes codes in the shape Rails generates" do
    golden.fetch("codes").each do |entry|
      expect(entry["device_code"]).to match(/\A[A-Za-z0-9_-]{#{SecureRandom.urlsafe_base64(32).length}}\z/)
      expect(entry["user_code"]).to match(/\AGRD-[A-Z0-9]{4}-[A-Z0-9]{4}\z/)
      expect(entry["device_code_digest"]).to eq(OauthDeviceAuthorization.digest(entry["device_code"]))
      expect(entry["user_code_digest"]).to eq(OauthDeviceAuthorization.digest(OauthDeviceAuthorization.normalize_user_code(entry["user_code"])))
    end
  end

  it "finds every Node code by its device code and by its user code, typed any way" do
    golden.fetch("codes").each do |entry|
      authorization = insert_node_code(entry)

      expect(OauthDeviceAuthorization.find_by_device_code(entry["device_code"])).to eq(authorization)
      expect(OauthDeviceAuthorization.find_by_user_code(entry["user_code"])).to eq(authorization)
      expect(OauthDeviceAuthorization.find_by_user_code(entry["user_code"].delete("-").downcase)).to eq(authorization)
      expect(authorization).to be_approvable
      authorization.delete
    end
  end

  it "lets Rails approve every Node code and redeem it at the token endpoint for a token that authenticates API requests" do
    golden.fetch("codes").each do |entry|
      authorization = insert_node_code(entry)
      expect(authorization.approve!(resource_owner:, ip_address: "203.0.113.10", user_agent: "browser")).to be(true)

      post "/oauth/token", params: { grant_type: OauthDeviceAuthorization::GRANT_TYPE, client_id: application.uid, device_code: entry["device_code"] }

      expect(response).to have_http_status(:ok), "#{entry["example"]}: #{response.body}"
      expect(response.parsed_body["scope"]).to eq(Doorkeeper::OAuth::Scopes.from_string(entry["scopes"]).to_s)
      expect(authorization.reload).to be_consumed
      get "/api/v2/user", headers: { "Authorization" => "Bearer #{response.parsed_body["access_token"]}" }
      expect(response).to have_http_status(:ok)
      Doorkeeper::AccessToken.where(application_id: application.id).delete_all
      Doorkeeper::AccessGrant.where(application_id: application.id).delete_all
      authorization.delete
    end
  end

  it "authenticates API requests with every token Node issued for a device code and redeems its refresh token" do
    golden.fetch("tokens").each do |entry|
      Doorkeeper::AccessToken.insert_all!([{
                                            resource_owner_id: resource_owner.id,
                                            application_id: application.id,
                                            token: entry.fetch("access_token"),
                                            refresh_token: entry.fetch("refresh_token"),
                                            expires_in: nil,
                                            scopes: entry.fetch("scopes"),
                                            created_at: Time.current.change(usec: 0)
                                          }])

      get "/api/v2/user", headers: { "Authorization" => "Bearer #{entry["access_token"]}" }
      expect(response).to have_http_status(:ok), "#{entry["example"]}: #{response.body}"

      post "/oauth/token", params: { grant_type: "refresh_token", refresh_token: entry["refresh_token"], client_id: application.uid }
      expect(response).to have_http_status(:ok), "#{entry["example"]}: #{response.body}"
      expect(Doorkeeper::AccessToken.find_by(token: entry["access_token"]).reload.revoked_at).to be_present
      Doorkeeper::AccessToken.where(application_id: application.id).delete_all
    end
  end

  it "reuses the access grant Node wrote when Rails issues the next token for the same owner, application and scopes" do
    entry = golden.fetch("tokens").first
    grant = entry.fetch("grant")
    Doorkeeper::AccessGrant.insert_all!([{
                                          resource_owner_id: resource_owner.id,
                                          application_id: application.id,
                                          token: grant.fetch("token"),
                                          expires_in: grant.fetch("expires_in"),
                                          redirect_uri: grant.fetch("redirect_uri"),
                                          scopes: grant.fetch("scopes"),
                                          created_at: Time.current.change(usec: 0)
                                        }])
    authorization, device_code, = OauthDeviceAuthorization.create_for!(oauth_application: application, scopes: grant.fetch("scopes"), ip_address: "203.0.113.10", user_agent: "Gumroad CLI")
    authorization.approve!(resource_owner:, ip_address: "203.0.113.10", user_agent: "browser")

    post "/oauth/token", params: { grant_type: OauthDeviceAuthorization::GRANT_TYPE, client_id: application.uid, device_code: }

    expect(response).to have_http_status(:ok)
    expect(Doorkeeper::AccessGrant.where(application_id: application.id).count).to eq(1)
  end
end
