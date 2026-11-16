# frozen_string_literal: true

require "spec_helper"

# The review reminder subscribe and unsubscribe links, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the last request of each example.
describe "Review reminder links", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Reminder User", email: "reminder-user@example.com", password: "a-long-password-1", created_at: Time.utc(2025, 1, 1)) }
  let(:scope) { "unsubscribe_review_reminders" }

  before { host! DOMAIN }

  describe "GET /users/unsubscribe_review_reminders" do
    it "opts the signed-in visitor out", parity: true do
      log_in(user)
      get "/users/unsubscribe_review_reminders"

      expect(response).to be_successful
      expect(user.reload.opted_out_of_review_reminders?).to eq(true)
    end

    it "redirects a signed-out visitor to the login page", parity: true do
      get "/users/unsubscribe_review_reminders"

      expect(response).to redirect_to(login_url(next: "/users/unsubscribe_review_reminders"))
    end
  end

  describe "GET /users/subscribe_review_reminders" do
    it "opts the signed-in visitor back in", parity: true do
      user.update!(opted_out_of_review_reminders: true)
      log_in(user)
      get "/users/subscribe_review_reminders"

      expect(response).to be_successful
      expect(user.reload.opted_out_of_review_reminders?).to eq(false)
    end
  end

  describe "GET /users/unsubscribe_review_reminders/:id" do
    it "opts the token's owner out and links a tokenized resubscribe", parity: true do
      get "/users/unsubscribe_review_reminders/#{user.secure_external_id(scope:)}"

      expect(response).to be_successful
      expect(user.reload.opted_out_of_review_reminders?).to eq(true)
    end

    it "redirects to the root for a garbage token", parity: true do
      get "/users/unsubscribe_review_reminders/not-a-real-token"

      expect(response).to redirect_to(root_path)
    end

    it "still opts out an account that fails validation", parity: true do
      user.update_columns(name: "x" * 200)
      get "/users/unsubscribe_review_reminders/#{user.secure_external_id(scope:)}"

      expect(user.reload.opted_out_of_review_reminders?).to eq(true)
    end
  end

  describe "GET /users/subscribe_review_reminders/:id" do
    it "opts the token's owner back in", parity: true do
      user.update!(opted_out_of_review_reminders: true)
      get "/users/subscribe_review_reminders/#{user.secure_external_id(scope:)}"

      expect(response).to be_successful
      expect(user.reload.opted_out_of_review_reminders?).to eq(false)
    end
  end
end
