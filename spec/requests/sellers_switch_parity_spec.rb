# frozen_string_literal: true

require "spec_helper"

# The account switcher (Sellers::SwitchController#create), recorded for the Next.js port (PARITY_RECORD=1) with
# SECRET_KEY_BASE=parity-replay-secret-key-base, so the replay can read the current_seller_id cookie, and replayed by
# nextjs/parity/__tests__/ws11-public.replay.test.ts.
describe "Switching accounts", type: :request do
  include Parity::AudienceSignedIn

  let(:member) { create(:user, name: "Team Member") }
  let(:seller) { create(:named_seller) }
  let!(:membership) { create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN, last_accessed_at: Time.utc(2025, 1, 1)) }

  before { host! DOMAIN }

  def switch(team_membership_id)
    post sellers_switch_path, params: { authenticity_token: csrf_token, team_membership_id: }
  end

  it "remembers the seller and stamps the membership", parity: true do
    log_in(member)

    switch(membership.external_id)

    expect(response).to have_http_status(:no_content)
    expect(set_cookies).to include("current_seller_id=")
    expect(membership.reload.last_accessed_at).to be_present
  end

  it "does nothing for a membership id that does not exist", parity: true do
    log_in(member)

    switch("unknown-membership")

    expect(response).to have_http_status(:no_content)
    expect(set_cookies).not_to include("current_seller_id=")
  end

  it "does nothing for a membership of another user", parity: true do
    other = build(:team_membership, user: create(:user), seller: create(:user), role: TeamMembership::ROLE_ADMIN).tap { |row| row.save!(validate: false) }
    log_in(member)

    switch(other.external_id)

    expect(response).to have_http_status(:no_content)
    expect(set_cookies).not_to include("current_seller_id=")
  end

  it "does nothing for a membership that was removed", parity: true do
    membership.update_columns(deleted_at: Time.utc(2025, 2, 1))
    log_in(member)

    switch(membership.external_id)

    expect(response).to have_http_status(:no_content)
    expect(set_cookies).not_to include("current_seller_id=")
  end
end
