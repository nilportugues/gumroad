# frozen_string_literal: true

require "spec_helper"

# The mobile API on the API host, through the full Rack stack. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/mobile-api.replay.test.ts. Each example
# makes one request, so a fixture is one exchange.
describe "Mobile API parity", type: :request do
  let(:seller) { create(:user) }
  let(:application) { create(:oauth_application, owner: seller) }
  let(:mobile_token) { Api::Mobile::BaseController::MOBILE_TOKEN }

  before { host! API_DOMAIN }

  def token_for(owner = seller, scopes: "mobile_api", **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: owner.id, scopes:, **attributes).token
  end

  # The purchase factories charge a card through Stripe; the row is all these endpoints read.
  def purchase_row(factory = :purchase, **attributes)
    build(factory, **attributes).tap { |row| row.save!(validate: false) }
  end

  # The factory's start and end differ by less than the recorder's time buckets, so the replay would seed them equal.
  def call_of(purchase)
    purchase.call.tap { |call| Call.where(id: call.id).update_all(start_time: 2.days.from_now, end_time: 2.days.from_now + 3.hours) }
  end

  def auth(owner = seller, **options)
    { mobile_token:, access_token: token_for(owner, **options) }
  end

  describe "token checks" do
    it "refuses a request without the mobile token", parity: true do
      get "/mobile/feature_flags/test_feature", params: { access_token: token_for }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "message" => "Invalid request")
    end

    it "refuses a wrong mobile token", parity: true do
      get "/mobile/feature_flags/test_feature", params: { mobile_token: "nope", access_token: token_for }

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a request without an access token", parity: true do
      get "/mobile/feature_flags/test_feature", params: { mobile_token: }

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to include("invalid_token")
    end

    it "refuses an expired access token", parity: true do
      get "/mobile/feature_flags/test_feature", params: auth(expires_in: 60, created_at: 2.hours.ago)

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to include("expired")
    end

    it "refuses a revoked access token", parity: true do
      get "/mobile/feature_flags/test_feature", params: auth(revoked_at: 1.hour.ago)

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to include("revoked")
    end

    it "forbids a token without the mobile_api scope", parity: true do
      get "/mobile/feature_flags/test_feature", params: auth(scopes: "view_public")

      expect(response).to have_http_status(:forbidden)
    end

    it "takes the access token from the Authorization header", parity: true do
      get "/mobile/feature_flags/test_feature", params: { mobile_token: }, headers: { "Authorization" => "Bearer #{token_for}" }

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /mobile/feature_flags/:id" do
    it "is false for a feature that does not exist", parity: true do
      get "/mobile/feature_flags/test_feature", params: auth

      expect(response.parsed_body).to eq("enabled_for_user" => false)
    end

    it "is true for a feature enabled for everyone", parity: true do
      Feature.activate(:test_feature)

      get "/mobile/feature_flags/test_feature", params: auth

      expect(response.parsed_body).to eq("enabled_for_user" => true)
    end

    it "is true for a feature enabled for the user", parity: true do
      Feature.activate_user(:test_feature, seller)

      get "/mobile/feature_flags/test_feature", params: auth

      expect(response.parsed_body).to eq("enabled_for_user" => true)
    end

    it "is false for a feature enabled for another user", parity: true do
      Feature.activate_user(:test_feature, create(:user))

      get "/mobile/feature_flags/test_feature", params: auth

      expect(response.parsed_body).to eq("enabled_for_user" => false)
    end

    it "is true for a percentage rollout that includes the user", parity: true do
      Feature.activate_percentage(:test_feature, 100)

      get "/mobile/feature_flags/test_feature", params: auth

      expect(response.parsed_body).to eq("enabled_for_user" => true)
    end
  end

  describe "POST /mobile/devices" do
    let(:device) { { token: "abc", device_type: "ios", app_type: Device::APP_TYPES[:creator], app_version: "1.0.0" } }

    it "registers a device", parity: true do
      post "/mobile/devices", params: auth.merge(device:)

      expect(response).to have_http_status(:created)
      expect(response.parsed_body).to eq("success" => true)
    end

    it "registers a device sent as JSON", parity: true do
      post "/mobile/devices", params: auth.merge(device:).to_json, headers: { "Content-Type" => "application/json" }

      expect(response).to have_http_status(:created)
    end

    it "registers a device with the creator_api scope", parity: true do
      post "/mobile/devices", params: auth(scopes: "creator_api").merge(device:)

      expect(response).to have_http_status(:created)
    end

    it "moves a token another user held to this user", parity: true do
      other = create(:user)
      other.devices.create!(token: "abc", device_type: "ios", app_type: "creator")

      post "/mobile/devices", params: auth.merge(device:)

      expect(response).to have_http_status(:created)
    end

    it "rejects a device with an unknown type", parity: true do
      post "/mobile/devices", params: auth.merge(device: device.merge(device_type: "palm"))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a device without a token", parity: true do
      post "/mobile/devices", params: auth.merge(device: device.except(:token))

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "registers a device on the team member, not the brand, for a brand token", parity: true do
      brand = create(:user)
      membership = create(:team_membership, user: seller, seller: brand, role: TeamMembership::ROLE_ADMIN)
      brand_token = MobileAccountToken.issue!(application:, scopes: "mobile_api", expires_in: nil, resource_owner: brand, team_membership: membership)

      post "/mobile/devices", params: { mobile_token:, access_token: brand_token.token, device: }

      expect(response).to have_http_status(:created)
    end
  end

  describe "PUT /mobile/calls/:id" do
    let(:seller) { create(:user, :eligible_for_service_products) }
    let(:call) { call_of(purchase_row(:call_purchase, link: create(:call_product, :available_for_a_year, user: seller), seller:)) }

    it "updates the call url", parity: true do
      put "/mobile/calls/#{call.external_id}", params: auth.merge(call_url: "https://zoom.us/j/updated")

      expect(response.parsed_body).to eq("success" => true)
    end

    it "clears the call url", parity: true do
      call.update!(call_url: "https://zoom.us/j/old")

      patch "/mobile/calls/#{call.external_id}", params: auth

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 404 for another seller's call", parity: true do
      other = create(:user, :eligible_for_service_products)
      other_call = call_of(purchase_row(:call_purchase, link: create(:call_product, :available_for_a_year, user: other), seller: other))

      put "/mobile/calls/#{other_call.external_id}", params: auth.merge(call_url: "https://zoom.us/j/hacked")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find call")
    end

    it "answers 404 for a call that does not exist", parity: true do
      put "/mobile/calls/nope", params: auth.merge(call_url: "https://zoom.us/j/x")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "PUT /mobile/licenses/:id" do
    let(:product) { create(:product, user: seller, is_licensed: true) }
    let(:purchase) { purchase_row(link: product, seller:) }
    let(:license) { create(:license, link: product, purchase:) }

    it "disables a license", parity: true do
      put "/mobile/licenses/#{license.external_id}", params: auth.merge(enabled: "false")

      expect(response.parsed_body).to eq("success" => true)
    end

    it "enables a disabled license", parity: true do
      license.disable!

      put "/mobile/licenses/#{license.external_id}", params: auth.merge(enabled: "true")

      expect(response.parsed_body).to eq("success" => true)
    end

    it "enables a disabled license when enabled is an array", parity: true do
      license.disable!

      put "/mobile/licenses/#{license.external_id}", params: auth.merge(enabled: ["false"])

      expect(response.parsed_body).to eq("success" => true)
      expect(license.reload).not_to be_disabled
    end

    it "disables a license when enabled is missing", parity: true do
      patch "/mobile/licenses/#{license.external_id}", params: auth

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 404 for another seller's license", parity: true do
      other = create(:user)
      other_product = create(:product, user: other, is_licensed: true)
      other_license = create(:license, link: other_product, purchase: purchase_row(link: other_product, seller: other))

      put "/mobile/licenses/#{other_license.external_id}", params: auth.merge(enabled: "false")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find license")
    end
  end

  describe "POST /mobile/media_locations" do
    let(:buyer) { create(:user) }
    let(:product) { create(:product, user: seller) }
    let(:video) { create(:streamable_video, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/sample.mov") }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: buyer.email) }
    let!(:url_redirect) { purchase.create_url_redirect! }
    let(:location) do
      { product_file_id: video.external_id, url_redirect_id: url_redirect.external_id, purchase_id: purchase.external_id, platform: "android", consumed_at: "2015-09-09T17:26:50-07:00", location: 1 }
    end

    before { video }

    it "records where the buyer stopped", parity: true do
      post "/mobile/media_locations", params: auth(buyer).merge(location)

      expect(response.parsed_body).to eq("success" => true)
    end

    it "updates a location recorded earlier", parity: true do
      post "/mobile/media_locations", params: auth(buyer).merge(location)
      post "/mobile/media_locations", params: auth(buyer).merge(location.merge(consumed_at: "2016-09-09T17:26:50-07:00", location: 5))

      expect(response.parsed_body).to eq("success" => true)
    end

    it "ignores an older location", parity: true do
      post "/mobile/media_locations", params: auth(buyer).merge(location)
      post "/mobile/media_locations", params: auth(buyer).merge(location.merge(consumed_at: "2014-09-09T17:26:50-07:00", location: 5))

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for an unknown platform", parity: true do
      post "/mobile/media_locations", params: auth(buyer).merge(location.merge(platform: "palm"))

      expect(response.parsed_body).to eq("success" => false)
    end

    it "takes the purchase from the url redirect when it is not sent", parity: true do
      post "/mobile/media_locations", params: auth(buyer).merge(location.except(:purchase_id))

      expect(response.parsed_body).to eq("success" => true)
    end
  end

  describe "GET /mobile/url_redirects/(stream|hls_playlist|download)/:token/:product_file_id" do
    let(:buyer) { create(:user) }
    let(:product) { create(:product, user: seller) }
    let!(:product_file) { create(:readable_document, link: product) }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: buyer.email) }
    let!(:url_redirect) { purchase.create_url_redirect! }

    it "answers 404 for a refunded purchase", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get "/mobile/url_redirects/stream/#{url_redirect.token}/#{product_file.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find url redirect")
    end

    it "answers 404 for an unknown token", parity: true do
      get "/mobile/url_redirects/stream/unknown-token/#{product_file.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find url redirect")
    end

    it "answers 401 for an expired rental", parity: true do
      url_redirect.is_rental = true
      url_redirect.update_attribute(:rental_first_viewed_at, 5.days.ago)
      purchase.update_columns(rental_expired: true)

      get "/mobile/url_redirects/stream/#{url_redirect.token}/#{product_file.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "message" => "Your rental has expired.")
    end

    it "answers 404 for revoked access to a playlist", parity: true do
      purchase.update_attribute(:is_access_revoked, true)

      get "/mobile/url_redirects/hls_playlist/#{url_redirect.token}/#{product_file.external_id}/index.m3u8", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for revoked access to a download", parity: true do
      purchase.update_attribute(:is_access_revoked, true)

      get "/mobile/url_redirects/download/#{url_redirect.token}/#{product_file.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
    end
  end
end
