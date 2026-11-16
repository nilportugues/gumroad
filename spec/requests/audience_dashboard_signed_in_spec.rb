# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /dashboard/audience, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/dashboard-pages.replay.test.ts, which sends the last request of each example.
describe "Audience dashboard when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Audience Seller") }
  let(:deferred_headers) do
    { "X-Inertia" => "true", "X-Inertia-Partial-Component" => "Audience/Index", "X-Inertia-Partial-Data" => "audience_data", "X-Requested-With" => "XMLHttpRequest" }
  end

  before do
    host! DOMAIN
    # The recorder resets ids for every example, so events of an earlier example would be this seller's.
    ConfirmedFollowerEvent.__elasticsearch__.create_index!(force: true)
  end

  # Midday in the seller's zone, so the replay clock (whole hours) cannot move an event across a day.
  def follow(email, days_ago:, removed_days_ago: nil)
    follower = create(:follower, user: seller, email:, confirmed_at: nil)
    follower.update!(confirmed_at: days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12))
    follower.update!(confirmed_at: nil, deleted_at: removed_days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 14)) if removed_days_ago
    ElasticsearchIndexerWorker.drain
    ConfirmedFollowerEvent.__elasticsearch__.refresh_index!
    follower
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get audience_dashboard_path

    expect(response).to redirect_to(login_path(next: "/dashboard/audience"))
  end

  it "lets a marketing team member see the seller's audience", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    follow("newer@example.com", days_ago: 3)
    log_in(member)
    switch_to(membership)

    get audience_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["total_follower_count"]).to eq(1)
  end

  it "remembers the audience dashboard as the preferred one and defers the chart data for a seller without followers", parity: true do
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
    expect(set_cookies).to include("last_viewed_dashboard=audience")
    expect(inertia_props_of(response)).to include("total_follower_count" => 0)
  end

  it "counts the followers and defers the chart data", parity: true do
    follow("older@example.com", days_ago: 9)
    follow("newer@example.com", days_ago: 3)
    follow("gone@example.com", days_ago: 6, removed_days_ago: 2)
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["total_follower_count"]).to eq(2)
  end

  it "answers the chart data of the default range as a partial reload", parity: true do
    follow("older@example.com", days_ago: 9)
    follow("newer@example.com", days_ago: 3)
    follow("gone@example.com", days_ago: 6, removed_days_ago: 2)
    log_in(seller)

    get audience_dashboard_path, headers: deferred_headers

    expect(response).to be_successful
    expect(response.parsed_body.dig("props", "audience_data", "new_followers")).to eq(2)
  end

  it "answers the chart data of a range the seller picked", parity: true do
    follow("older@example.com", days_ago: 9)
    follow("newer@example.com", days_ago: 3)
    log_in(seller)

    get audience_dashboard_path(from: 5.days.ago.to_date.to_s, to: 1.day.ago.to_date.to_s), headers: deferred_headers

    expect(response).to be_successful
    expect(response.parsed_body.dig("props", "audience_data", "new_followers")).to eq(1)
  end

  it "falls back to the last 30 days when the range cannot be parsed", parity: true do
    follow("newer@example.com", days_ago: 3)
    log_in(seller)

    get audience_dashboard_path(from: "yesterday-ish", to: "x"), headers: deferred_headers

    expect(response).to be_successful
    expect(response.parsed_body.dig("props", "audience_data", "new_followers")).to eq(1)
  end

  it "ends a range that stops before it starts on the start date", parity: true do
    follow("newer@example.com", days_ago: 3)
    log_in(seller)

    get audience_dashboard_path(from: 2.days.ago.to_date.to_s, to: 8.days.ago.to_date.to_s), headers: deferred_headers

    expect(response).to be_successful
  end
end
