# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the subscribers page, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/audience-pages.replay.test.ts, which sends the last request
# of each example.
describe "Followers when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Followed Seller") }

  before { host! DOMAIN }

  def follow(email, confirmed_at:, **attributes)
    # Midday, so the replay clock (which seeds times in whole hours) cannot move the date.
    create(:follower, user: seller, email:, confirmed_at: confirmed_at && confirmed_at + 12.hours, **attributes)
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get followers_path

    expect(response).to redirect_to(login_path(next: "/followers"))
  end

  it "lists no subscribers for a seller without followers and records the view", parity: true do
    log_in(seller)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("followers" => [], "total_count" => 0, "page" => 1, "has_more" => false, "email" => "")
  end

  it "lists the confirmed followers newest first and leaves out the unconfirmed and removed", parity: true do
    follow("older@example.com", confirmed_at: Time.utc(2025, 1, 2, 3, 4, 5), created_at: Time.utc(2025, 1, 1), source: "profile")
    follow("newer@example.com", confirmed_at: Time.utc(2025, 3, 9, 10, 0, 0), created_at: Time.utc(2025, 3, 8))
    follow("unconfirmed@example.com", confirmed_at: nil)
    follow("removed@example.com", confirmed_at: nil, deleted_at: Time.utc(2025, 2, 5))
    create(:follower, user: create(:user), email: "someone-else@example.com", confirmed_at: Time.utc(2025, 2, 1))
    log_in(seller)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["followers"].map { _1["email"] }).to eq(["newer@example.com", "older@example.com"])
    expect(inertia_props_of(response)["total_count"]).to eq(2)
  end

  it "searches the emails of the followers", parity: true do
    follow("alice@example.com", confirmed_at: Time.utc(2025, 1, 1))
    follow("bob@example.org", confirmed_at: Time.utc(2025, 1, 2))
    follow("alice.smith@example.net", confirmed_at: Time.utc(2025, 1, 3))
    log_in(seller)

    get followers_path, params: { email: "  alice " }

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("email" => "alice", "total_count" => 3)
    expect(inertia_props_of(response)["followers"].map { _1["email"] }).to eq(["alice.smith@example.net", "alice@example.com"])
  end

  it "says there are more followers than one page holds", parity: true do
    21.times { |index| follow("follower#{index}@example.com", confirmed_at: Time.utc(2025, 1, 1) + index.days) }
    log_in(seller)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("page" => 1, "has_more" => true, "total_count" => 21)
    expect(inertia_props_of(response)["followers"].size).to eq(20)
  end

  it "answers the next page as a partial reload without recording another view", parity: true do
    21.times { |index| follow("follower#{index}@example.com", confirmed_at: Time.utc(2025, 1, 1) + index.days) }
    log_in(seller)

    get followers_path, params: { page: 2 },
                        headers: { "X-Inertia" => "true", "X-Inertia-Partial-Component" => "Followers/Index", "X-Inertia-Partial-Data" => "followers,has_more,page", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to be_successful
    expect(response.parsed_body["props"]).to include("page" => 2, "has_more" => false)
    expect(response.parsed_body["props"]["followers"].size).to eq(1)
  end

  it "answers a page past the end with no followers", parity: true do
    follow("only@example.com", confirmed_at: Time.utc(2025, 1, 1))
    log_in(seller)

    get followers_path, params: { page: 7 }

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("followers" => [], "page" => 7, "has_more" => false)
  end

  it "lets a support team member remove followers but not a marketing one", parity: true do
    follow("member@example.com", confirmed_at: Time.utc(2025, 1, 1))
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["followers"].first).to include("can_update" => false)
  end

  it "lets an admin team member update followers", parity: true do
    follow("member@example.com", confirmed_at: Time.utc(2025, 1, 1))
    member = create(:user, name: "Admin Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["followers"].first).to include("can_update" => true)
  end

  it "sends an admin who is impersonating away without recording a view", parity: true do
    follow("member@example.com", confirmed_at: Time.utc(2025, 1, 1))
    admin = create(:admin_user, name: "Gumroad Admin")
    log_in(admin)
    $redis.set(RedisKey.impersonated_user(admin.id), seller.id)

    get followers_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["followers"].size).to eq(1)
  end
end
