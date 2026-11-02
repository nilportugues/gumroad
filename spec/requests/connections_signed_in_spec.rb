# frozen_string_literal: true

require "spec_helper"

# Unlinking a social connection the way the profile settings page does (JSON, the CSRF token in a header), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/oauth-integrations.replay.test.ts, which sends the last request of each example.
describe "Social connections when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Connected Seller") }
  let(:json_headers) { { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings/profile" } }

  before { host! DOMAIN }

  def unlink(provider)
    post "/settings/connections/unlink_#{provider}", headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  it "unlinks YouTube", parity: true do
    create(:user_youtube_identity, user: seller)
    log_in(seller)

    unlink("youtube")

    expect(response.parsed_body).to eq("success" => true)
    expect(UserYoutubeIdentity.count).to eq(0)
  end

  it "answers success when YouTube was not linked", parity: true do
    log_in(seller)

    unlink("youtube")

    expect(response.parsed_body).to eq("success" => true)
  end

  it "unlinks Instagram and keeps the verification as dormant evidence", parity: true do
    verification = create(:social_connect_verification, user: seller, platform: "instagram", uid: "17841400000000001")
    create(:user_instagram_identity, user: seller, instagram_user_id: "17841400000000001")
    log_in(seller)

    unlink("instagram")

    expect(response.parsed_body).to eq("success" => true)
    expect(UserInstagramIdentity.count).to eq(0)
    expect(verification.reload.superseded_at).to be_nil
  end

  it "unlinks TikTok", parity: true do
    create(:user_tiktok_identity, user: seller)
    log_in(seller)

    unlink("tiktok")

    expect(response.parsed_body).to eq("success" => true)
    expect(UserTiktokIdentity.count).to eq(0)
  end

  it "hands unlinking X back to Rails", parity: true do
    seller.update!(twitter_user_id: "123", twitter_handle: "gumroad")
    log_in(seller)

    unlink("twitter")

    expect(response.parsed_body).to eq("success" => true)
    expect(seller.reload.twitter_user_id).to be_nil
  end

  it "refuses a support team member", parity: true do
    create(:user_youtube_identity, user: seller)
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    unlink("youtube")

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    expect(UserYoutubeIdentity.count).to eq(1)
  end

  it "refuses an admin team member", parity: true do
    create(:user_tiktok_identity, user: seller)
    member = create(:user, name: "Admin Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    unlink("tiktok")

    expect(response).to have_http_status(:unauthorized)
    expect(UserTiktokIdentity.count).to eq(1)
  end
end
