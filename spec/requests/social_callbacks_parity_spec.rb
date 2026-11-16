# frozen_string_literal: true

require "spec_helper"

# The Instagram and TikTok deauthorize and data-deletion webhooks, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/oauth-integrations.replay.test.ts. Signatures are real HMACs over the secrets stubbed here.
describe "Social platform callbacks", type: :request do
  let(:instagram_secret) { "instagram-parity-secret" }
  let(:tiktok_secret) { "tiktok-parity-secret" }
  let(:instagram_user_id) { 17841400000000001 }

  before do
    host! DOMAIN
    stub_const("INSTAGRAM_APP_SECRET", instagram_secret)
    stub_const("TIKTOK_CLIENT_SECRET", tiktok_secret)
  end

  def b64(value) = Base64.urlsafe_encode64(value, padding: false)

  def signed_request(payload = nil, secret: instagram_secret, **fields)
    payload ||= fields
    encoded = b64(payload.is_a?(String) ? payload : payload.to_json)
    "#{b64(OpenSSL::HMAC.digest("SHA256", secret, encoded))}.#{encoded}"
  end

  def tiktok_signature(body, secret: tiktok_secret, timestamp: Time.current.to_i)
    "t=#{timestamp},s=#{OpenSSL::HMAC.hexdigest("SHA256", secret, "#{timestamp}.#{body}")}"
  end

  def link_instagram(uid: instagram_user_id.to_s)
    verification = create(:social_connect_verification, platform: "instagram", uid:)
    create(:user_instagram_identity, user: verification.user, instagram_user_id: uid)
    verification
  end

  describe "Instagram" do
    it "unlinks the identity on deauthorize and supersedes the verification", parity: true do
      verification = link_instagram
      other = link_instagram(uid: "17841400000000002")

      post "/instagram/deauthorize", params: { signed_request: signed_request("algorithm" => "HMAC-SHA256", "user_id" => instagram_user_id) }

      expect(response).to have_http_status(:ok)
      expect(verification.reload.superseded_at).to be_present
      expect(other.reload.superseded_at).to be_nil
    end

    it "reads a string user id", parity: true do
      verification = link_instagram

      post "/instagram/deauthorize", params: { signed_request: signed_request("algorithm" => "hmac-sha256", "user_id" => instagram_user_id.to_s) }

      expect(verification.reload.superseded_at).to be_present
    end

    it "leaves an already superseded verification alone", parity: true do
      verification = link_instagram
      verification.update_columns(superseded_at: 3.days.ago)

      post "/instagram/deauthorize", params: { signed_request: signed_request("algorithm" => "HMAC-SHA256", "user_id" => instagram_user_id.to_s) }

      expect(response).to have_http_status(:ok)
    end

    it "rejects a signature made with another secret", parity: true do
      link_instagram

      post "/instagram/deauthorize", params: { signed_request: signed_request({ "algorithm" => "HMAC-SHA256", "user_id" => instagram_user_id }, secret: "other") }

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a missing signed request", parity: true do
      post "/instagram/deauthorize"

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects another algorithm", parity: true do
      post "/instagram/deauthorize", params: { signed_request: signed_request("algorithm" => "HMAC-SHA1", "user_id" => instagram_user_id) }

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a payload without a user id", parity: true do
      post "/instagram/deauthorize", params: { signed_request: signed_request("algorithm" => "HMAC-SHA256") }

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a payload that is not JSON", parity: true do
      post "/instagram/deauthorize", params: { signed_request: signed_request("not json") }

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a signature that is not base64", parity: true do
      post "/instagram/deauthorize", params: { signed_request: "!!!.abc" }

      expect(response).to have_http_status(:bad_request)
    end

    it "deletes the identity and verification on data deletion and answers a status URL", parity: true do
      verification = link_instagram
      other = link_instagram(uid: "17841400000000002")

      post "/instagram/data_deletion", params: { signed_request: signed_request("algorithm" => "HMAC-SHA256", "user_id" => instagram_user_id) }

      expect(response).to have_http_status(:ok)
      expect(SocialConnectVerification.exists?(verification.id)).to be(false)
      expect(SocialConnectVerification.exists?(other.id)).to be(true)
      expect(response.parsed_body["confirmation_code"]).to match(/\A[0-9a-f]{48}\z/)
    end

    it "rejects a data deletion request with a bad signature", parity: true do
      post "/instagram/data_deletion", params: { signed_request: "x.y" }

      expect(response).to have_http_status(:bad_request)
    end

    it "reports a valid confirmation code as completed", parity: true do
      code = InstagramSignedRequest.new.confirmation_code(instagram_user_id.to_s)

      get "/instagram/data_deletion/#{code}"

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq("Instagram data deletion completed.")
    end

    it "answers 404 to a forged confirmation code", parity: true do
      get "/instagram/data_deletion/#{'a' * 48}"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a malformed confirmation code", parity: true do
      get "/instagram/data_deletion/invalid"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "TikTok" do
    let(:open_id) { "tiktok-open-id-1" }

    def link_tiktok
      verification = create(:social_connect_verification, platform: "tiktok", uid: open_id)
      create(:user_tiktok_identity, user: verification.user, tiktok_open_id: open_id)
      verification
    end

    def deauthorize(payload = nil, signature: nil, headers: {}, **fields)
      payload ||= fields
      body = payload.is_a?(String) ? payload : payload.to_json
      post "/tiktok/deauthorize", params: body, headers: { "Content-Type" => "application/json", "TikTok-Signature" => signature || tiktok_signature(body) }.merge(headers)
    end

    it "unlinks the identity when authorization is removed", parity: true do
      verification = link_tiktok

      deauthorize("event" => "authorization.removed", "user_openid" => open_id)

      expect(response).to have_http_status(:ok)
      expect(verification.reload.superseded_at).to be_present
      expect(UserTiktokIdentity.count).to eq(0)
    end

    it "acknowledges another event without touching the identity", parity: true do
      link_tiktok

      deauthorize("event" => "video.upload", "user_openid" => open_id)

      expect(response).to have_http_status(:ok)
      expect(UserTiktokIdentity.count).to eq(1)
    end

    it "rejects a payload without an open id", parity: true do
      deauthorize("event" => "authorization.removed")

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a bad signature", parity: true do
      link_tiktok

      deauthorize({ "event" => "authorization.removed", "user_openid" => open_id }, signature: "t=#{Time.current.to_i},s=#{'0' * 64}")

      expect(response).to have_http_status(:bad_request)
      expect(UserTiktokIdentity.count).to eq(1)
    end

    it "rejects a stale timestamp", parity: true do
      body = { "event" => "authorization.removed", "user_openid" => open_id }.to_json

      deauthorize(body, signature: tiktok_signature(body, timestamp: 1.hour.ago.to_i))

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a missing signature header", parity: true do
      post "/tiktok/deauthorize", params: { event: "authorization.removed" }.to_json, headers: { "Content-Type" => "application/json" }

      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a body that is not an object", parity: true do
      deauthorize("[1]")

      expect(response).to have_http_status(:bad_request)
    end
  end
end
