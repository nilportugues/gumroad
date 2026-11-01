# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the Agent tab, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws75-pages.replay.test.ts, which sends the last request of each example.
describe "Agent page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Agent Seller") }

  it "redirects a signed-out visitor to the login page", parity: true do
    get agent_path

    expect(response).to redirect_to(login_path(next: "/agent"))
  end

  it "renders the locked tab for a seller who has not earned access", parity: true do
    log_in(seller)

    get agent_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("eligible" => false, "locked_heading" => "Agent unlocks after your first payout")
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    log_in(seller)

    inertia_visit agent_path

    expect(response).to be_successful
    expect(response.parsed_body["component"]).to eq("Agent/Index")
  end

  it "lets an admin team member in", parity: true do
    member = create(:user, name: "Team Admin")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get agent_path

    expect(response).to be_successful
  end

  it "sends an accountant team member to the dashboard with the role in the flash", parity: true do
    member = create(:user, name: "Team Accountant")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(member)
    switch_to(membership)

    get agent_path

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Accountant cannot perform this action.")
  end
end
