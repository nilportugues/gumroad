# frozen_string_literal: true

require "spec_helper"

# POST /subscriptions/:subscription_id/magic_link, recorded for the Next.js port (PARITY_RECORD=1) through the full Rack
# stack and replayed by nextjs/parity/__tests__/subscription-magic-links.replay.test.ts, which sends the last request of each
# example. Node answers the lookups that 404; a request that would refresh the token and send the email goes to Rails.
describe "Subscription magic links", type: :request do
  let(:subscription) { create(:membership_purchase, email: "member@example.com").subscription }

  before { host! DOMAIN }

  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"].fetch("authenticity_token")
  end

  def send_link(external_id, **params)
    post subscription_magic_link_path(external_id), params: { authenticity_token: csrf_token, **params }
  end

  it "answers an unknown subscription with a 404", parity: true do
    send_link("unknown-subscription", email_source: "subscription")

    expect(response).to have_http_status(:not_found)
  end

  it "answers a request without an email source with a 404", parity: true do
    send_link(subscription.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "answers an unknown email source with a 404", parity: true do
    send_link(subscription.external_id, email_source: "other")

    expect(response).to have_http_status(:not_found)
  end

  it "answers a blank email source with a 404", parity: true do
    send_link(subscription.external_id, email_source: "")

    expect(response).to have_http_status(:not_found)
  end

  it "answers an email source that is not a string with a 404", parity: true do
    send_link(subscription.external_id, email_source: { user: "1" })

    expect(response).to have_http_status(:not_found)
  end

  it "answers the account email of a subscription with no account with a 404", parity: true do
    subscription.update_columns(user_id: nil)

    send_link(subscription.external_id, email_source: "user")

    expect(response).to have_http_status(:not_found)
  end

  it "hands a link to the subscription email to Rails", parity: true do
    send_link(subscription.external_id, email_source: "subscription")

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, email_sent: "subscription"))
  end

  it "hands a link to the purchase email to Rails", parity: true do
    send_link(subscription.external_id, email_source: "purchase")

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, email_sent: "purchase"))
  end

  it "hands a link to the account email to Rails", parity: true do
    subscription.update!(user: create(:user, email: "account-holder@example.com"))

    send_link(subscription.external_id, email_source: "user")

    expect(response).to redirect_to(new_subscription_magic_link_path(subscription.external_id, email_sent: "user"))
  end
end
