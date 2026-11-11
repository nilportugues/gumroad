# frozen_string_literal: true

require "spec_helper"

# The confirmation page behind the unsubscribe link of feature announcement emails (Users::FeatureAnnouncementsController#confirm_unsubscribe)
# and the POST behind its button (#unsubscribe), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the last request of each example.
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

  describe "POST" do
    let(:token) { FeatureAnnouncementSubscription.unsubscribe_token(user, user.email) }
    let(:inertia) { { "X-Inertia" => "true" } }

    it "unsubscribes a subscribed user and renders the done page", parity: true do
      FeatureAnnouncementSubscription.update_from_settings!(user, subscribed: true, rendered_version: 0)

      post "/users/unsubscribe_feature_announcements/#{token}", headers: inertia

      expect(response).to be_successful
      expect(response.parsed_body.fetch("props").values_at("unsubscribed", "unsubscribe_url")).to eq([true, nil])
      expect(response.headers.values_at("Referrer-Policy", "Cache-Control", "X-Robots-Tag")).to eq(["no-referrer", "no-store", "noindex"])
      expect(FeatureAnnouncementSubscription.find_by(user_id: user.id)).to have_attributes(subscribed: false, version: 2, source: "unsubscribe_link")
    end

    it "leaves a tombstone for a user with no subscription row", parity: true do
      post "/users/unsubscribe_feature_announcements/#{token}", headers: inertia

      expect(response).to be_successful
      expect(FeatureAnnouncementSubscription.find_by(user_id: user.id)).to have_attributes(subscribed: false, version: 1, source: "unsubscribe_link")
    end

    it "changes nothing for a user who already unsubscribed", parity: true do
      FeatureAnnouncementSubscription.update_from_settings!(user, subscribed: true, rendered_version: 0)
      FeatureAnnouncementSubscription.unsubscribe!(user, source: "newsletter_opt_out")
      before = FeatureAnnouncementSubscription.find_by(user_id: user.id).attributes

      post "/users/unsubscribe_feature_announcements/#{token}", headers: inertia

      expect(response).to be_successful
      expect(FeatureAnnouncementSubscription.find_by(user_id: user.id).attributes).to eq(before)
    end

    it "answers 404 for a token that does not decrypt", parity: true do
      post "/users/unsubscribe_feature_announcements/not-a-real-token", headers: inertia

      expect(response).to have_http_status(:not_found)
      expect(response.headers["Referrer-Policy"]).to eq("no-referrer")
      expect(FeatureAnnouncementSubscription.count).to eq(0)
    end

    it "answers 404 when the token's user no longer exists", parity: true do
      token
      user.delete

      post "/users/unsubscribe_feature_announcements/#{token}", headers: inertia

      expect(response).to have_http_status(:not_found)
    end

    it "hands a one-click post without the Inertia header to Rails", parity: true do
      FeatureAnnouncementSubscription.update_from_settings!(user, subscribed: true, rendered_version: 0)

      post "/users/unsubscribe_feature_announcements/#{token}"

      expect(response).to be_successful
      expect(FeatureAnnouncementSubscription.subscribed?(user)).to eq(false)
    end
  end
end
