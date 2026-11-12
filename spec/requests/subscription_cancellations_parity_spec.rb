# frozen_string_literal: true

require "spec_helper"

# POST /subscriptions/:id/unsubscribe_by_seller (the customers page) and /unsubscribe_by_user (the manage page), recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/subscription-cancellations.replay.test.ts, which sends the
# last request of each example. Both run Subscription#cancel!, so every example that cancels also records the mail and webhook jobs.
# Examples named `hands a ...` are the requests the port leaves to Rails whole.
# The audience projection rebuild is recorded as the job it is (RefreshAudienceMemberJob), not run inline.
describe "Subscription cancellations", type: :request, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Cancel Seller") }
  let(:product) { create(:membership_product, user: seller) }
  let(:purchase) { create(:membership_purchase, link: product, email: "member@example.com") }
  let(:subscription) { purchase.subscription.tap { |record| record.update_columns(user_id: member.id) } }
  let(:member) { create(:user, name: "Cancel Member") }
  let(:headers) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  def unsubscribe_by_seller(target = subscription.external_id)
    post unsubscribe_by_seller_subscription_path(target), headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  def unsubscribe_by_user(target = subscription.external_id, **params)
    post unsubscribe_by_user_subscription_path(target), params: { authenticity_token: csrf_token, **params }
  end

  describe "by the seller" do
    it "cancels the membership at the end of the paid period", parity: true do
      log_in(seller)

      unsubscribe_by_seller

      expect(response).to have_http_status(:no_content)
      expect(subscription.reload.cancelled_at).to be_present
      expect(subscription.cancelled_by_buyer?).to eq(false)
    end

    it "does not email the seller about it when payment emails are off", parity: true do
      seller.update!(enable_payment_email: false)
      log_in(seller)

      unsubscribe_by_seller

      expect(response).to have_http_status(:no_content)
      expect(subscription.reload.cancelled_at).to be_present
    end

    it "ends a free trial membership when the trial ends", parity: true do
      trial = create(:free_trial_membership_purchase, link: create(:membership_product, :with_free_trial_enabled, user: seller), email: "trial@example.com")
      log_in(seller)

      unsubscribe_by_seller(trial.subscription.external_id)

      expect(response).to have_http_status(:no_content)
      expect(trial.subscription.reload.cancelled_at).to eq(trial.subscription.free_trial_ends_at)
    end

    it "leaves a subscription that is already cancelled alone", parity: true do
      subscription.cancel!(by_seller: false)
      log_in(seller)

      unsubscribe_by_seller

      expect(response).to have_http_status(:no_content)
      expect(subscription.reload.cancelled_by_buyer?).to eq(true)
    end

    it "lets a support team member cancel", parity: true do
      support = create(:user, name: "Support Member")
      membership = create(:team_membership, user: support, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(support)
      switch_to(membership)

      unsubscribe_by_seller

      expect(response).to have_http_status(:no_content)
      expect(subscription.reload.cancelled_at).to be_present
    end

    it "refuses a marketing team member", parity: true do
      marketer = create(:user, name: "Marketing Member")
      membership = create(:team_membership, user: marketer, seller:, role: TeamMembership::ROLE_MARKETING)
      log_in(marketer)
      switch_to(membership)

      unsubscribe_by_seller

      expect(response).to have_http_status(:unauthorized)
      expect(subscription.reload.cancelled_at).to be_nil
    end

    it "refuses the subscription of another seller", parity: true do
      log_in(create(:user, name: "Other Seller"))

      unsubscribe_by_seller

      expect(response).to have_http_status(:unauthorized)
      expect(subscription.reload.cancelled_at).to be_nil
    end

    it "answers an unknown subscription with success false", parity: true do
      log_in(seller)

      unsubscribe_by_seller("unknown-subscription")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a signed-out request to Rails", parity: true do
      unsubscribe_by_seller

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "by the member" do
    it "cancels when the signed-in member owns the subscription", parity: true do
      log_in(member)

      unsubscribe_by_user

      expect(response).to redirect_to(manage_subscription_path(subscription.external_id))
      expect(flash[:notice]).to eq("Your membership has been cancelled.")
      expect(subscription.reload.cancelled_by_buyer?).to eq(true)
    end

    it "answers an Inertia form post the same way", parity: true do
      log_in(member)

      post unsubscribe_by_user_subscription_path(subscription.external_id), headers: { "X-Inertia" => "true", "X-CSRF-Token" => csrf_token }

      expect(response).to redirect_to(manage_subscription_path(subscription.external_id))
      expect(subscription.reload.cancelled_at).to be_present
    end

    it "cancels with an unexpired token", parity: true do
      token = subscription.refresh_token

      unsubscribe_by_user(token:)

      expect(response).to redirect_to(manage_subscription_path(subscription.external_id))
      expect(subscription.reload.cancelled_at).to be_present
    end

    it "sends a visitor without access to the magic link page", parity: true do
      unsubscribe_by_user

      expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id))
      expect(subscription.reload.cancelled_at).to be_nil
    end

    it "sends a visitor with an expired token to the magic link page", parity: true do
      token = subscription.refresh_token
      subscription.update!(token_expires_at: 1.hour.ago)

      unsubscribe_by_user(token:)

      expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, invalid: true))
      expect(subscription.reload.cancelled_at).to be_nil
    end

    it "answers an ended subscription with a 404", parity: true do
      subscription.update_columns(ended_at: 1.day.ago)
      log_in(member)

      unsubscribe_by_user

      expect(response).to have_http_status(:not_found)
    end

    it "answers an unknown subscription with success false", parity: true do
      unsubscribe_by_user("unknown-subscription")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "keeps the first cancellation when the member cancels twice", parity: true do
      subscription.cancel!(by_seller: true)
      log_in(member)

      unsubscribe_by_user

      expect(response).to redirect_to(manage_subscription_path(subscription.external_id))
      expect(subscription.reload.cancelled_by_buyer?).to eq(false)
    end
  end
end
