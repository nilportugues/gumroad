# frozen_string_literal: true

require "spec_helper"

# Removing a subscriber from the subscribers page (FollowersController#destroy), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts.
describe "Followers mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Followed Seller") }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end

  before { host! DOMAIN }

  # Midday, so the replay clock (which seeds times in whole hours) cannot move the date.
  def follow(email, confirmed_at: Time.utc(2025, 1, 2, 12, 4, 5), user: seller, **attributes)
    create(:follower, user:, email:, confirmed_at:, created_at: Time.utc(2025, 1, 1, 12), **attributes)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def remove(follower, headers: inertia_headers)
    delete follower_path(follower.external_id), headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  describe "DELETE /followers/:id" do
    it "removes a confirmed follower with its audience member row", parity: true do
      follower = follow("confirmed@example.com")
      log_in(seller)

      remove(follower)

      expect(response).to redirect_to(followers_path)
      expect(response).to have_http_status(:see_other)
      expect(follower.reload).to have_attributes(confirmed_at: nil, deleted_at: be_present)
      expect(AudienceMember.where(seller:, email: "confirmed@example.com")).to be_empty
    end

    it "removes a follower who never confirmed", parity: true do
      follower = follow("unconfirmed@example.com", confirmed_at: nil)
      log_in(seller)

      remove(follower)

      expect(response).to have_http_status(:see_other)
      expect(follower.reload.deleted_at).to be_present
    end

    it "removes a follower who was already removed", parity: true do
      follower = follow("again@example.com", confirmed_at: nil, deleted_at: Time.utc(2025, 2, 5, 12))
      log_in(seller)

      remove(follower)

      expect(response).to have_http_status(:see_other)
      expect(follower.reload.deleted_at).to be > Time.utc(2025, 2, 5, 12)
    end

    it "keeps the other followers of the seller", parity: true do
      follower = follow("first@example.com")
      follow("second@example.com", confirmed_at: Time.utc(2025, 1, 3, 12))
      log_in(seller)

      remove(follower)

      expect(Follower.alive.where(followed_id: seller.id).pluck(:email)).to eq(["second@example.com"])
      expect(AudienceMember.where(seller:).pluck(:email)).to eq(["second@example.com"])
    end

    it "lets an admin team member remove a follower", parity: true do
      follower = follow("byadmin@example.com")
      as_team_member(:admin)

      remove(follower)

      expect(response).to have_http_status(:see_other)
      expect(follower.reload.deleted_at).to be_present
    end

    it "lets a support team member remove a follower", parity: true do
      follower = follow("bysupport@example.com")
      as_team_member(:support)

      remove(follower)

      expect(response).to have_http_status(:see_other)
      expect(follower.reload.deleted_at).to be_present
    end

    it "sends a marketing team member to the dashboard with an alert", parity: true do
      follower = follow("marketing@example.com")
      as_team_member(:marketing)

      remove(follower)

      expect(response).to redirect_to(dashboard_path)
      expect(follower.reload.deleted_at).to be_nil
    end

    it "removes the follower of another seller, as the policy only asks about the role", parity: true do
      other = create(:user, name: "Other Seller")
      follower = follow("elsewhere@example.com", user: other)
      log_in(seller)

      remove(follower)

      expect(response).to have_http_status(:see_other)
      expect(follower.reload.deleted_at).to be_present
    end

    it "answers 404 for an unknown follower", parity: true do
      log_in(seller)

      delete follower_path("unknownid"), headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a follower who is also a customer to Rails", parity: true do
      follower = follow("buyer@example.com")
      member = AudienceMember.find_by!(seller:, email: "buyer@example.com")
      member.update!(details: member.details.merge("purchases" => [{ "id" => 1, "product_id" => 1, "price_cents" => 100, "created_at" => "2025-01-01T12:00:00.000Z" }]))
      log_in(seller)

      remove(follower)

      expect(AudienceMember.find_by(seller:, email: "buyer@example.com")).to have_attributes(follower: false, customer: true)
    end

    it "hands a follower of a seller with a newsletter cutover to Rails", parity: true do
      follower = follow("newsletter@example.com")
      FeatureAnnouncementNewsletterCutover.create!(seller:, state: "migrated", cutoff_at: Time.utc(2025, 1, 1, 12))
      log_in(seller)

      remove(follower)

      expect(follower.reload.deleted_at).to be_present
    end

    it "hands a signed-out visitor to Rails", parity: true do
      follower = follow("signedout@example.com")

      delete follower_path(follower.external_id), headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:see_other)
    end
  end
end
