# frozen_string_literal: true

require "spec_helper"

# The link in the follow confirmation email (FollowersController#confirm), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts.
describe "Follow confirmation link", type: :request do
  let(:seller) { create(:user, name: "Followed Seller", username: "followedseller") }

  before { host! DOMAIN }

  # Midday, so the replay clock (which seeds times in whole hours) cannot move the date.
  def follow(email, confirmed_at: nil, user: seller, **attributes)
    create(:follower, user:, email:, confirmed_at:, created_at: Time.utc(2025, 1, 1, 12), **attributes)
  end

  it "confirms an unconfirmed follower and sends them to the seller's profile", parity: true do
    follower = follow("pending@example.com")

    get confirm_follow_path(follower.external_id)

    expect(response).to redirect_to("#{PROTOCOL}://followedseller.#{ROOT_DOMAIN}")
    expect(follower.reload).to have_attributes(confirmed_at: be_present, deleted_at: nil)
    expect(AudienceMember.where(seller:, email: "pending@example.com").pluck(:follower)).to eq([true])
  end

  it "leaves a confirmed follower as they are", parity: true do
    follower = follow("confirmed@example.com", confirmed_at: Time.utc(2025, 1, 2, 12))

    get confirm_follow_path(follower.external_id)

    expect(response).to have_http_status(:found)
    expect(follower.reload.confirmed_at).to eq(Time.utc(2025, 1, 2, 12))
  end

  it "confirms a follower who had been removed", parity: true do
    follower = follow("returning@example.com", deleted_at: Time.utc(2025, 2, 5, 12))

    get confirm_follow_path(follower.external_id)

    expect(response).to have_http_status(:found)
    expect(follower.reload).to have_attributes(confirmed_at: be_present, deleted_at: nil)
  end

  it "answers 404 for an unknown follower", parity: true do
    get confirm_follow_path("unknownid")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when the seller is suspended", parity: true do
    follower = follow("suspended@example.com")
    seller.update_columns(user_risk_state: "suspended_for_tos_violation")

    get confirm_follow_path(follower.external_id)

    expect(response).to have_http_status(:not_found)
    expect(follower.reload.confirmed_at).to be_nil
  end

  it "hands a seller with follower workflows to Rails", parity: true do
    follower = follow("workflow@example.com")
    create(:follower_workflow, seller:)

    get confirm_follow_path(follower.external_id)

    expect(follower.reload.confirmed_at).to be_present
  end

  it "hands a seller with a newsletter cutover to Rails", parity: true do
    follower = follow("newsletter@example.com")
    FeatureAnnouncementNewsletterCutover.create!(seller:, state: "migrated", cutoff_at: Time.utc(2025, 1, 1, 12))

    get confirm_follow_path(follower.external_id)

    expect(follower.reload.confirmed_at).to be_present
  end

  it "hands a follower who is also a customer to Rails", parity: true do
    follower = follow("buyer@example.com")
    create(:audience_member, seller:, email: "buyer@example.com", purchases: [{ created_at: "2025-01-01T12:00:00Z" }])

    get confirm_follow_path(follower.external_id)

    expect(AudienceMember.find_by(seller:, email: "buyer@example.com")).to have_attributes(follower: true, customer: true)
  end
end
