# frozen_string_literal: true

require "spec_helper"

# The legacy post link (PostsController#redirect_from_purchase_id), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12b.replay.test.ts.
describe "Legacy post link when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Posting Seller", username: "postingseller") }
  let(:post_record) { create(:audience_post, :published, seller:, name: "Launch notes", message: "<p>Hello</p>") }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def get_legacy(post, purchase_id: "somepurchase", headers: {})
    get redirect_from_purchase_id_path(purchase_id:, id: post.external_id), headers:
  end

  it "redirects to the post page with the purchase id", parity: true do
    log_in(seller)

    get_legacy(post_record)

    expect(response).to redirect_to("/postingseller/p/#{post_record.slug}?purchase_id=somepurchase")
  end

  it "escapes the purchase id in the query", parity: true do
    log_in(seller)

    get_legacy(post_record, purchase_id: "a b&c")

    expect(response).to have_http_status(:found)
  end

  it "names the seller by external id when the account has no username", parity: true do
    seller.update_columns(username: nil)
    log_in(seller)

    get_legacy(post_record)

    expect(response).to redirect_to("/#{seller.external_id}/p/#{post_record.slug}?purchase_id=somepurchase")
  end

  it "lets a marketing team member follow the link", parity: true do
    as_team_member(TeamMembership::ROLE_MARKETING)

    get_legacy(post_record)

    expect(response).to have_http_status(:found)
    expect(response.location).to include("/p/#{post_record.slug}")
  end

  it "sends a support team member to the dashboard with an alert", parity: true do
    as_team_member(TeamMembership::ROLE_SUPPORT)

    get_legacy(post_record)

    expect(response).to redirect_to("/dashboard")
    expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
  end

  it "answers 401 JSON to a team member who may not follow the link", parity: true do
    as_team_member(TeamMembership::ROLE_ACCOUNTANT)

    get_legacy(post_record, headers: { "Accept" => "application/json" })

    expect(response).to have_http_status(:unauthorized)
  end

  it "answers 404 for an unknown post", parity: true do
    log_in(seller)

    get redirect_from_purchase_id_path(purchase_id: "somepurchase", id: "unknownpostid")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the post of a suspended seller", parity: true do
    log_in(seller)
    post_record
    seller.update_columns(user_risk_state: "suspended_for_tos_violation")

    get_legacy(post_record)

    expect(response).to have_http_status(:not_found)
  end

  it "hands a signed-out visitor to Rails", parity: true do
    get_legacy(post_record)

    expect(response).to redirect_to("/dashboard")
  end
end
