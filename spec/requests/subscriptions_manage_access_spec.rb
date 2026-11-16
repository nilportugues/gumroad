# frozen_string_literal: true

require "spec_helper"

# Who may open /subscriptions/:id/manage, recorded for the Next.js port (PARITY_RECORD=1) through the full Rack
# stack, signed out and signed in. Replayed by nextjs/parity/__tests__/checkout-payouts.replay.test.ts. A visitor
# who may manage gets the page from Rails, so only the refusals are recorded here.
describe "Managing a subscription: access", type: :request do
  include Parity::SignedInDashboard

  let(:subscription) { create(:membership_purchase, email: "member@example.com").subscription }

  it "sends a visitor without a cookie or token to the magic link page", parity: true do
    get manage_subscription_path(subscription.external_id)

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id))
    expect(response.headers["X-Robots-Tag"]).to eq("noindex")
  end

  it "sends a visitor with an unknown token to the magic link page and says it is invalid", parity: true do
    subscription.refresh_token

    get manage_subscription_path(subscription.external_id, token: "not-the-token")

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, invalid: true))
  end

  it "does not accept an expired token", parity: true do
    token = subscription.refresh_token
    subscription.update!(token_expires_at: 1.hour.ago)

    get manage_subscription_path(subscription.external_id, token:)

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, invalid: true))
  end

  it "answers an unknown subscription with a 404", parity: true do
    get manage_subscription_path("unknown-subscription")

    expect(response).to have_http_status(:not_found)
  end

  it "answers an ended subscription with a 404", parity: true do
    subscription.update_columns(ended_at: 1.day.ago)

    get manage_subscription_path(subscription.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "answers an installment plan whose charges are all collected with a 404", parity: true do
    subscription.update_columns(flags: subscription.flags | Subscription.flag_mapping["flags"][:is_installment_plan], charge_occurrence_count: subscription.purchases.successful.count)

    get manage_subscription_path(subscription.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "sends a signed-in buyer who does not own the subscription to the magic link page", parity: true do
    log_in(create(:user, name: "Other Buyer"))

    get manage_subscription_path(subscription.external_id)

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id))
  end

  it "keeps a token that is not a string out of the comparison", parity: true do
    get manage_subscription_path(subscription.external_id, token: "")

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id))
  end
end
