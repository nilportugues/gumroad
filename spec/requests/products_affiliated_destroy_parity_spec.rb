# frozen_string_literal: true

require "spec_helper"

# DELETE /products/affiliated/:id (Products::AffiliatedController#destroy), recorded for the Next.js port (PARITY_RECORD=1) and replayed
# by nextjs/parity/__tests__/ws12o.replay.test.ts, which sends the last request of each example. Node answers the 404s and the policy;
# an example named "hands a ..." is a removal that passes both, which Node leaves to Rails whole because it soft-deletes the row and
# mails the seller.
describe "Products::AffiliatedController#destroy", type: :request do
  include Parity::AudienceSignedIn

  let(:affiliate_user) { create(:user, name: "Affiliate Person") }
  let(:creator) { create(:user, name: "Creator One", username: "creatorone") }
  let!(:direct_affiliate) { create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500) }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def remove(id = direct_affiliate.external_id)
    delete "/products/affiliated/#{id}", headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller: affiliate_user, role:)
    log_in(member)
    switch_to(membership)
  end

  it "answers 404 for an affiliation of the seller who added the affiliate", parity: true do
    log_in(creator)

    remove

    expect(response).to have_http_status(:not_found)
    expect(direct_affiliate.reload.deleted_at).to be_nil
  end

  it "answers 404 for an unknown affiliation", parity: true do
    log_in(affiliate_user)

    remove("nonexistent")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an affiliation that was already removed", parity: true do
    direct_affiliate.update_column(:deleted_at, Time.utc(2025, 2, 1))
    log_in(affiliate_user)

    remove

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the affiliation of another affiliate", parity: true do
    other = create(:user, name: "Other Affiliate")
    log_in(other)

    remove

    expect(response).to have_http_status(:not_found)
    expect(direct_affiliate.reload.deleted_at).to be_nil
  end

  it "refuses a marketing team member with the role in the message", parity: true do
    team_member(TeamMembership::ROLE_MARKETING)

    remove

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Marketing cannot perform this action.")
    expect(direct_affiliate.reload.deleted_at).to be_nil
  end

  it "refuses an accountant team member", parity: true do
    team_member(TeamMembership::ROLE_ACCOUNTANT)

    remove

    expect(response).to have_http_status(:unauthorized)
  end

  it "hands a removal by the affiliate to Rails", parity: true do
    log_in(affiliate_user)

    remove

    expect(response).to have_http_status(:ok)
    expect(direct_affiliate.reload.deleted_at).to be_present
  end

  it "hands a removal by an admin team member to Rails", parity: true do
    team_member(TeamMembership::ROLE_ADMIN)

    remove

    expect(response).to have_http_status(:ok)
  end
end
