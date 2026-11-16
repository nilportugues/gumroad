# frozen_string_literal: true

require "spec_helper"

# DELETE /affiliates/:id (AffiliatesController#destroy): the soft delete of a DirectAffiliate, the rewrite of the seller's audience
# member row, and the removal mail `AffiliateMailer.direct_affiliate_removal(id).deliver_later`. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/affiliates-destroy.replay.test.ts, which sends the last request of each
# example.
#
# `parity_mail_jobs` records the mail enqueue (the test adapter would swallow it), `parity_timeline` the order of the statements and
# jobs, `defer_audience_refresh` keeps RefreshAudienceMemberJob a queued job as in production. An example named "hands a ..." records
# what Node passes to Rails whole: the shape is not proven.
describe "Affiliates destroy", type: :request, parity_timeline: true, parity_mail_jobs: true, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:product) { create(:product, user: seller, name: "Affiliate product") }
  let(:other_product) { create(:product, user: seller, name: "Second affiliate product") }
  let(:affiliate_user) { create(:named_user, name: "Parity Affiliate") }
  let(:direct_affiliate) { create(:direct_affiliate, seller:, affiliate_user:, products: [product]) }

  before { host! DOMAIN }

  def send_delete(affiliate)
    token = csrf_token
    delete affiliate_path(affiliate.external_id),
           params: {}.to_json,
           headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => token }
  end

  # The projection is built by a job in production; `defer_audience_refresh` leaves it unrun here.
  def project_audience_member
    RefreshAudienceMemberJob.new.perform(affiliate_user.email, seller.id)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "deletes the affiliate, drops its audience member and queues the removal mail", parity: true do
    log_in(seller)
    direct_affiliate
    project_audience_member
    expect(AudienceMember.where(seller:).count).to eq(1)

    send_delete(direct_affiliate)

    expect(response).to have_http_status(:see_other)
    expect(direct_affiliate.reload).to be_deleted
    expect(AudienceMember.where(seller:).count).to eq(0)
  end

  it "deletes an affiliate with two products", parity: true do
    log_in(seller)
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product, other_product], apply_to_all_products: true)
    project_audience_member

    send_delete(affiliate)

    expect(response).to have_http_status(:see_other)
    expect(affiliate.reload).to be_deleted
  end

  it "deletes an affiliate who turned posts off, which has no audience member", parity: true do
    log_in(seller)
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product], send_posts: false)

    send_delete(affiliate)

    expect(response).to have_http_status(:see_other)
    expect(affiliate.reload).to be_deleted
  end

  it "lets an admin team member delete an affiliate", parity: true do
    as_team_member(TeamMembership::ROLE_ADMIN)
    direct_affiliate
    project_audience_member

    send_delete(direct_affiliate)

    expect(response).to have_http_status(:see_other)
    expect(direct_affiliate.reload).to be_deleted
  end

  it "hands the removal of an affiliate who is also a customer", parity: true do
    log_in(seller)
    direct_affiliate
    build(:purchase, link: product, seller:, email: affiliate_user.email, purchase_state: "successful").save!(validate: false)
    project_audience_member

    send_delete(direct_affiliate)

    expect(response).to have_http_status(:see_other)
  end

  it "hands the removal of an affiliate with a destination url", parity: true do
    log_in(seller)
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product], destination_url: "https://example.com/landing")

    send_delete(affiliate)

    expect(response).to have_http_status(:see_other)
  end

  it "deletes an affiliate that is already deleted again, moving deleted_at and mailing again", parity: true do
    log_in(seller)
    direct_affiliate.mark_deleted!

    send_delete(direct_affiliate)

    expect(response).to have_http_status(:see_other)
  end

  it "refuses the removal of an affiliate with a fee outside the allowed range", parity: true do
    log_in(seller)
    direct_affiliate.update_column(:affiliate_basis_points, 50)

    send_delete(direct_affiliate)

    expect(response).to have_http_status(:unprocessable_content)
  end

  it "hands the removal of an affiliate whose seller has no username", parity: true do
    log_in(seller)
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product, other_product], destination_url: "https://example.com/landing")
    affiliate.update_column(:destination_url, nil)
    seller.update_column(:username, nil)

    send_delete(affiliate)

    expect(response).to have_http_status(:see_other)
  end
end
