# frozen_string_literal: true

require "spec_helper"

# DELETE /products/affiliated/:id for a removal that passes the lookup and the policy (Products::AffiliatedController#destroy): the
# conditional UPDATE that soft-deletes the affiliation, `AffiliateMailer.direct_affiliate_removal_by_affiliate_user(id).deliver_later`
# and the page props. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/products-affiliated-removal.replay.test.ts. `parity_mail_jobs` records the mail enqueue, `parity_timeline`
# the order of the statement and the job. Every shape Node cannot prove is refused before the UPDATE by assertAffiliatedSupported, which has no recorded example here.
describe "Products::AffiliatedController#destroy removal", type: :request, parity_timeline: true, parity_mail_jobs: true do
  include Parity::AudienceSignedIn

  let(:affiliate_user) { create(:user, name: "Affiliate Person") }
  let(:creator) { create(:user, name: "Creator One", username: "creatorone") }
  let(:other_creator) { create(:user, name: "Creator Two", username: "creatortwo") }
  let(:product) { create(:product, user: creator, name: "Creator product") }
  let(:other_product) { create(:product, user: other_creator, name: "Other product") }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def remove(affiliate)
    delete "/products/affiliated/#{affiliate.external_id}", headers: json_headers.merge("X-CSRF-Token" => @token)
  end

  # The first page render is slow; fetch the token before the rows are created so the seed is not seconds old when the request runs.
  def prime_token
    @token = csrf_token
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller: affiliate_user, role:)
    log_in(member)
    switch_to(membership)
  end

  it "removes the affiliation and queues the mail to the seller", parity: true do
    log_in(affiliate_user)
    prime_token
    affiliate = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500, products: [product])

    remove(affiliate)

    expect(response).to have_http_status(:ok)
    expect(affiliate.reload.deleted_at).to be_present
    expect(affiliate).to be_removed_at_request
  end

  it "removes one affiliation and keeps listing the other", parity: true do
    log_in(affiliate_user)
    prime_token
    affiliate = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500, products: [product])
    create(:direct_affiliate, seller: other_creator, affiliate_user:, affiliate_basis_points: 2000, products: [other_product])

    remove(affiliate)

    expect(response).to have_http_status(:ok)
    expect(affiliate.reload.deleted_at).to be_present
  end

  it "lets an admin team member remove the affiliation", parity: true do
    team_member(TeamMembership::ROLE_ADMIN)
    prime_token
    affiliate = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500, products: [product])

    remove(affiliate)

    expect(response).to have_http_status(:ok)
    expect(affiliate.reload.deleted_at).to be_present
  end

  it "removes an affiliation whose row no longer validates", parity: true do
    log_in(affiliate_user)
    prime_token
    affiliate = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500, products: [product])
    affiliate.update_column(:affiliate_basis_points, 50)

    remove(affiliate)

    expect(response).to have_http_status(:ok)
    expect(affiliate.reload.deleted_at).to be_present
  end

  it "removes the affiliation of an account enrolled as a global affiliate", parity: true do
    log_in(affiliate_user)
    prime_token
    affiliate = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1500, products: [product])
    affiliate_user.global_affiliate

    remove(affiliate)

    expect(response).to have_http_status(:ok)
  end
end
