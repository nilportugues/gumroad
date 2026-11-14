# frozen_string_literal: true

require "spec_helper"

# Api::Mobile::AccountsController and ConsumptionAnalyticsController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/mobile-api.replay.test.ts.
describe "Mobile API accounts and consumption", type: :request do
  include Parity::MobileApi

  let(:user) { create(:user, name: "Mobile Member") }
  let(:first_party_application) { create(:oauth_application, owner: user, uid: OauthApplication::MOBILE_API_OAUTH_APPLICATION_UID) }

  def first_party_auth(owner = user, **attributes)
    token = create("doorkeeper/access_token", application: first_party_application, resource_owner_id: owner.id, scopes: "mobile_api creator_api", **attributes).token
    { mobile_token:, access_token: token }
  end

  describe "GET /mobile/accounts" do
    it "lists the account alone", parity: true do
      get "/mobile/accounts", params: auth(user)

      expect(response.parsed_body["accounts"].size).to eq(1)
    end

    it "lists the brands the user administers, most recently used first", parity: true do
      older = create(:user, name: "Older Brand")
      newer = create(:user, name: "Newer Brand")
      create(:team_membership, user:, seller: older, role: TeamMembership::ROLE_ADMIN, last_accessed_at: 3.days.ago)
      create(:team_membership, user:, seller: newer, role: TeamMembership::ROLE_ADMIN, last_accessed_at: 1.day.ago)
      create(:team_membership, user:, seller: create(:user), role: TeamMembership::ROLE_SUPPORT)
      create(:team_membership, user:, seller: create(:user), role: TeamMembership::ROLE_ADMIN, deleted_at: 1.day.ago)

      get "/mobile/accounts", params: auth(user)

      expect(response.parsed_body["accounts"].map { _1["name"] }).to eq(["Mobile Member", "Newer Brand", "Older Brand"])
    end

    it "flags the brand a brand token acts as", parity: true do
      brand = create(:user, name: "Active Brand")
      membership = create(:team_membership, user:, seller: brand, role: TeamMembership::ROLE_ADMIN)
      brand_token = MobileAccountToken.issue!(application: mobile_application, scopes: "mobile_api", expires_in: nil, resource_owner: brand, team_membership: membership)

      get "/mobile/accounts", params: { mobile_token:, access_token: brand_token.token }

      expect(response.parsed_body["accounts"].map { _1["is_active"] }).to eq([false, true])
    end

    it "refuses while impersonating", parity: true do
      admin = create(:admin_user)
      $redis.set(RedisKey.impersonated_user(admin.id), user.id)

      get "/mobile/accounts", params: auth(admin)

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "POST /mobile/accounts" do
    it "issues a token for the account itself", parity: true do
      post "/mobile/accounts", params: first_party_auth.merge(id: user.external_id)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "issues a brand token with the scopes of an admin and stamps the membership", parity: true do
      brand = create(:user, name: "Switch Brand")
      membership = create(:team_membership, user:, seller: brand, role: TeamMembership::ROLE_ADMIN)

      post "/mobile/accounts", params: first_party_auth.merge(id: brand.external_id)

      expect(response.parsed_body).to include("success" => true)
      expect(response.parsed_body["account"]).to include("id" => brand.external_id, "is_active" => true)
      token = Doorkeeper::AccessToken.find_by(resource_owner_id: brand.id)
      expect(token.team_membership_id).to eq(membership.id)
      expect(token.scopes.to_a).to eq(%w[mobile_api creator_api view_public edit_products view_sales edit_emails view_profile edit_profile view_payouts view_tax_data edit_sales refund_sales mark_sales_as_shipped])
      expect(membership.reload.last_accessed_at).to be_present
    end

    it "restores the own-account scopes when switching back from a brand", parity: true do
      brand = create(:user)
      membership = create(:team_membership, user:, seller: brand, role: TeamMembership::ROLE_ADMIN)
      brand_token = MobileAccountToken.issue!(application: first_party_application, scopes: "mobile_api creator_api view_public", expires_in: nil, resource_owner: brand, team_membership: membership)

      post "/mobile/accounts", params: { mobile_token:, access_token: brand_token.token, id: user.external_id }

      expect(response.parsed_body["account"]).to include("id" => user.external_id)
    end

    it "answers 404 for an account that does not exist", parity: true do
      post "/mobile/accounts", params: first_party_auth.merge(id: "nope")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token of another application", parity: true do
      post "/mobile/accounts", params: auth(user).merge(id: user.external_id)

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses an account the user is not an admin of", parity: true do
      other = create(:user)

      post "/mobile/accounts", params: first_party_auth.merge(id: other.external_id)

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a deleted account", parity: true do
      gone = create(:user, deleted_at: 1.day.ago)

      post "/mobile/accounts", params: first_party_auth.merge(id: gone.external_id)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /mobile/consumption_analytics" do
    let(:product) { create(:product, user: create(:user)) }
    let(:buyer) { create(:user) }
    let(:video) { create(:streamable_video, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/sample.mov") }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: buyer.email) }
    let!(:url_redirect) { purchase.create_url_redirect! }
    let(:event) { { url_redirect_id: url_redirect.external_id, product_file_id: video.external_id, event_type: "watch", platform: "android", consumed_at: "2024-05-01T10:00:00+02:00" } }

    before { video }

    it "records a watch event", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event)

      expect(response.parsed_body).to eq("success" => true)
    end

    it "takes the purchase from the url redirect and the time from the clock", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event.except(:consumed_at, :product_file_id))

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers false for an unknown event type", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event.merge(event_type: "sing"))

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for an unknown platform", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event.merge(platform: "palm"))

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false without a url redirect", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event.except(:url_redirect_id))

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for a url redirect id that does not decrypt", parity: true do
      post "/mobile/consumption_analytics", params: auth(buyer).merge(event.merge(url_redirect_id: "garbage"))

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
