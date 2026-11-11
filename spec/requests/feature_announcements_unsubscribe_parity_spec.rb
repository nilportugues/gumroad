# frozen_string_literal: true

require "spec_helper"

# The confirmation page behind the unsubscribe link of feature announcement emails (Users::FeatureAnnouncementsController#confirm_unsubscribe),
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the
# last request of each example.
describe "Feature announcement unsubscribe link", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Announcement User", email: "announcement-user@example.com", created_at: Time.utc(2025, 1, 1)) }

  before { host! DOMAIN }

  it "asks for confirmation without changing the subscription", parity: true do
    FeatureAnnouncementSubscription.update_from_settings!(user, subscribed: true, rendered_version: 0)

    get "/users/unsubscribe_feature_announcements/#{FeatureAnnouncementSubscription.unsubscribe_token(user, user.email)}"

    expect(response).to be_successful
    expect(response.headers.values_at("Referrer-Policy", "Cache-Control", "X-Robots-Tag")).to eq(["no-referrer", "no-store", "noindex"])
    expect(FeatureAnnouncementSubscription.subscribed?(user)).to eq(true)
  end

  it "answers 404 for a token that does not decrypt", parity: true do
    get "/users/unsubscribe_feature_announcements/not-a-real-token"

    expect(response).to have_http_status(:not_found)
    expect(response.headers["Referrer-Policy"]).to eq("no-referrer")
  end

  it "answers 404 for a token minted for another purpose", parity: true do
    get "/users/unsubscribe_feature_announcements/#{user.secure_external_id(scope: 'unsubscribe_review_reminders')}"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when the token's user no longer exists", parity: true do
    token = FeatureAnnouncementSubscription.unsubscribe_token(user, user.email)
    user.delete

    get "/users/unsubscribe_feature_announcements/#{token}"

    expect(response).to have_http_status(:not_found)
  end
end
