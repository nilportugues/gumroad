# frozen_string_literal: true

require "spec_helper"

# Mobile API requests the Next.js port leaves to Rails whole. Rails answers them here; the replay
# (nextjs/parity/__tests__/mobile-api.replay.test.ts) asserts that Node forwards each one, body included, and writes nothing.
describe "Mobile API hand backs", type: :request do
  include Parity::MobileApi

  let(:user) { create(:user) }

  it "hands a write that carries cookies to Rails", parity: true do
    post "/mobile/devices", params: auth(user).merge(device: { token: "abc", device_type: "ios", app_type: "creator" }), headers: { "Cookie" => "_gumroad_guid=0123456789abcdef" }

    expect(response).to have_http_status(:created)
  end

  it "hands a switch to a brand account to Rails", parity: true do
    first_party = create(:oauth_application, owner: user, uid: OauthApplication::MOBILE_API_OAUTH_APPLICATION_UID)
    brand = create(:user)
    create(:team_membership, user:, seller: brand, role: TeamMembership::ROLE_ADMIN)
    token = create("doorkeeper/access_token", application: first_party, resource_owner_id: user.id, scopes: "mobile_api creator_api").token

    post "/mobile/accounts", params: { mobile_token:, access_token: token, id: brand.external_id }

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "hands a consumed_at that is not ISO 8601 to Rails", parity: true do
    buyer = create(:user)
    product = create(:product, user: user)
    video = create(:streamable_video, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/sample.mov")
    purchase = create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
    url_redirect = purchase.create_url_redirect!

    post "/mobile/consumption_analytics", params: auth(buyer).merge(url_redirect_id: url_redirect.external_id, product_file_id: video.external_id, event_type: "watch", platform: "android", consumed_at: "May 1 2024 10:00 PDT")

    expect(response.parsed_body).to eq("success" => true)
  end

  it "reads a range written as day, month name and year", parity: true do
    get "/mobile/analytics/by_state", params: auth(user, scopes: "creator_api").merge(start_date: "1 March 2026", end_date: "2 March 2026")

    expect(response).to be_successful
  end
end
