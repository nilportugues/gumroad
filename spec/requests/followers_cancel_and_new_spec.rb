# frozen_string_literal: true

require "spec_helper"

# The unsubscribe link of a follow (FollowersController#cancel) and the follow page of a profile (#new), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts.
describe "Follower cancel and follow page links", type: :request do
  let!(:seller) { create(:user, name: "Followed Seller", username: "followedseller") }
  let(:json_headers) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  # Midday, so the replay clock (which seeds times in whole hours) cannot move the date.
  def follow(email, confirmed_at: Time.utc(2025, 1, 2, 12, 4, 5), user: seller, **attributes)
    create(:follower, user:, email:, confirmed_at:, created_at: Time.utc(2025, 1, 1, 12), **attributes)
  end

  describe "GET /follow/:id/cancel" do
    it "removes a confirmed follower and answers with its id as JSON", parity: true do
      follower = follow("confirmed@example.com")

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "follower_id" => follower.external_id)
      expect(follower.reload).to have_attributes(confirmed_at: nil, deleted_at: be_present)
      expect(AudienceMember.where(seller:, email: "confirmed@example.com")).to be_empty
    end

    it "removes a follower who never confirmed", parity: true do
      follower = follow("unconfirmed@example.com", confirmed_at: nil)

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(response.parsed_body).to eq("success" => true, "follower_id" => follower.external_id)
      expect(follower.reload.deleted_at).to be_present
    end

    it "removes a follower who was already removed", parity: true do
      follower = follow("again@example.com", confirmed_at: nil, deleted_at: Time.utc(2025, 2, 5, 12))

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(response).to have_http_status(:ok)
      expect(follower.reload.deleted_at).to be > Time.utc(2025, 2, 5, 12)
    end

    it "keeps the other followers of the seller", parity: true do
      follower = follow("first@example.com")
      follow("second@example.com", confirmed_at: Time.utc(2025, 1, 3, 12))

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(Follower.alive.where(followed_id: seller.id).pluck(:email)).to eq(["second@example.com"])
      expect(AudienceMember.where(seller:).pluck(:email)).to eq(["second@example.com"])
    end

    it "answers 404 for an unknown follower", parity: true do
      get cancel_follow_path("unknownid")

      expect(response).to have_http_status(:not_found)
    end

    it "removes the follower and renders the cancel page", parity: true do
      follower = follow("page@example.com")

      get cancel_follow_path(follower.external_id)

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Followers/Cancel")
      expect(follower.reload.deleted_at).to be_present
    end

    it "removes a follower who never confirmed and renders the cancel page", parity: true do
      follower = follow("page-unconfirmed@example.com", confirmed_at: nil)

      get cancel_follow_path(follower.external_id)

      expect(response.body).to include("Followers/Cancel")
      expect(follower.reload).to have_attributes(confirmed_at: nil, deleted_at: be_present)
    end

    it "removes a follower who was already removed and renders the cancel page", parity: true do
      follower = follow("page-again@example.com", confirmed_at: nil, deleted_at: Time.utc(2025, 2, 5, 12))

      get cancel_follow_path(follower.external_id)

      expect(response.body).to include("Followers/Cancel")
      expect(follower.reload.deleted_at).to be > Time.utc(2025, 2, 5, 12)
    end

    it "keeps the other followers of the seller when it renders the cancel page", parity: true do
      follower = follow("page-first@example.com")
      follow("page-second@example.com", confirmed_at: Time.utc(2025, 1, 3, 12))

      get cancel_follow_path(follower.external_id)

      expect(Follower.alive.where(followed_id: seller.id).pluck(:email)).to eq(["page-second@example.com"])
    end

    it "hands a cancel page of a follower under a newsletter cutover to Rails", parity: true do
      follower = follow("page-newsletter@example.com")
      FeatureAnnouncementNewsletterCutover.create!(seller:, state: "migrated", cutoff_at: Time.utc(2025, 1, 1, 12))

      get cancel_follow_path(follower.external_id)

      expect(follower.reload.deleted_at).to be_present
    end

    it "answers an Inertia visit with the page object after the write", parity: true do
      follower = follow("page-inertia@example.com")

      get cancel_follow_path(follower.external_id), headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response.parsed_body["component"]).to eq("Followers/Cancel")
      expect(follower.reload.deleted_at).to be_present
    end

    it "hands a JSON request for an unknown follower to Rails", parity: true do
      get cancel_follow_path("unknownid"), headers: json_headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a follower who is also a customer to Rails", parity: true do
      follower = follow("buyer@example.com")
      member = AudienceMember.find_by!(seller:, email: "buyer@example.com")
      member.update!(details: member.details.merge("purchases" => [{ "id" => 1, "product_id" => 1, "price_cents" => 100, "created_at" => "2025-01-01T12:00:00.000Z" }]))

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(AudienceMember.find_by(seller:, email: "buyer@example.com")).to have_attributes(follower: false, customer: true)
    end

    it "hands a follower of a seller with a newsletter cutover to Rails", parity: true do
      follower = follow("newsletter@example.com")
      FeatureAnnouncementNewsletterCutover.create!(seller:, state: "migrated", cutoff_at: Time.utc(2025, 1, 1, 12))

      get cancel_follow_path(follower.external_id), headers: json_headers

      expect(follower.reload.deleted_at).to be_present
    end
  end

  describe "GET /:username/follow" do
    it "redirects to the profile of the seller", parity: true do
      get follow_user_page_path("followedseller")

      expect(response).to redirect_to("#{PROTOCOL}://followedseller.#{ROOT_DOMAIN}")
      expect(response).to have_http_status(:found)
    end

    it "finds the seller by external id", parity: true do
      get follow_user_page_path(seller.external_id)

      expect(response).to redirect_to("#{PROTOCOL}://followedseller.#{ROOT_DOMAIN}")
    end

    it "answers 404 for an unknown username", parity: true do
      get follow_user_page_path("nobodyhere")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the seller is suspended", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_tos_violation")

      get follow_user_page_path("followedseller")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a JSON request for an unknown account to Rails", parity: true do
      get follow_user_page_path("nobodyhere"), headers: json_headers

      expect(response).to have_http_status(:not_found)
    end
  end
end
