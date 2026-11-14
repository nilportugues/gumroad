# frozen_string_literal: true

require "spec_helper"

# POST /affiliates (AffiliatesController#create) when it saves: the DirectAffiliate and its ProductAffiliate, the seller's audience
# member, the workflow schedule job, and the invitation mail `AffiliateMailer.direct_affiliate_invitation(id, nil).deliver_later(wait: 3.seconds)`.
# Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/affiliates-create.replay.test.ts, which sends the
# last request of each example.
#
# `parity_mail_jobs` records the mail enqueue (the test adapter would swallow it), `parity_timeline` the order of the statements and
# jobs, `defer_audience_refresh` keeps RefreshAudienceMemberJob a queued job as in production. An example named "hands a ..." records
# what Node passes to Rails whole: the shape is not proven.
describe "Affiliates create", type: :request, parity_timeline: true, parity_mail_jobs: true, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:product) { create(:product, user: seller, name: "Affiliate product") }
  let(:other_product) { create(:product, user: seller, name: "Second affiliate product") }
  let(:affiliate_user) { create(:named_user, name: "Parity Affiliate") }

  before { host! DOMAIN }

  def send_create(body)
    token = csrf_token
    post affiliates_path,
         params: body.to_json,
         headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => token }
  end

  def listed(target = product, fee_percent: 10, destination_url: nil, enabled: true)
    { id: target.external_id_numeric, enabled:, fee_percent:, destination_url: }
  end

  def body(products: [listed], email: affiliate_user.email, fee_percent: nil, destination_url: nil, apply_to_all_products: false)
    { affiliate: { email:, apply_to_all_products:, fee_percent:, destination_url:, products: } }
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  # The projection is built by a job in production; `defer_audience_refresh` leaves it unrun here.
  def project_audience_member
    RefreshAudienceMemberJob.new.perform(affiliate_user.email, seller.id)
  end

  def created_affiliate = seller.direct_affiliates.alive.find_by!(affiliate_user:)

  it "creates the affiliate with its product, an audience member, the workflow job and the invitation mail", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
    expect(response.location).to eq(affiliates_url)
    expect(created_affiliate.product_affiliates.pluck(:link_id)).to eq([product.id])
    expect(AudienceMember.where(seller:, email: affiliate_user.email).count).to eq(1)
  end

  it "lets an admin team member create an affiliate", parity: true do
    affiliate_user
    product
    as_team_member(TeamMembership::ROLE_ADMIN)

    send_create(body)

    expect(response).to have_http_status(:see_other)
    expect(created_affiliate).to be_present
  end

  it "takes the affiliate's fee from the top-level percentage when both are sent", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body(fee_percent: 25))

    expect(response).to have_http_status(:see_other)
    expect(created_affiliate.affiliate_basis_points).to eq(2500)
    expect(created_affiliate.product_affiliates.first.affiliate_basis_points).to eq(1000)
  end

  it "ignores a product that is listed but not enabled", parity: true do
    affiliate_user
    product
    other_product
    log_in(seller)

    send_create(body(products: [listed, listed(other_product, fee_percent: 30, enabled: false)]))

    expect(response).to have_http_status(:see_other)
    expect(created_affiliate.product_affiliates.pluck(:link_id)).to eq([product.id])
  end

  it "adds the affiliate to the audience member of someone who already follows the seller", parity: true do
    affiliate_user
    product
    create(:follower, user: seller, email: affiliate_user.email, confirmed_at: Time.current)
    project_audience_member
    expect(AudienceMember.where(seller:, email: affiliate_user.email).count).to eq(1)
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
    expect(AudienceMember.find_by!(seller:, email: affiliate_user.email).details.keys).to contain_exactly("follower", "affiliates")
  end

  it "creates the affiliate of a seller without a username when it has one product", parity: true do
    affiliate_user
    product
    seller.update_column(:username, nil)
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
  end

  it "re-adds someone whose earlier affiliation was removed", parity: true do
    affiliate_user
    product
    create(:direct_affiliate, seller:, affiliate_user:, products: [product]).mark_deleted!
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
    expect(seller.direct_affiliates.alive.where(affiliate_user:).count).to eq(1)
  end

  it "hands an affiliate for all products", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body(apply_to_all_products: true, fee_percent: 20))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an affiliate with two enabled products", parity: true do
    affiliate_user
    product
    other_product
    log_in(seller)

    send_create(body(products: [listed, listed(other_product, fee_percent: 15)]))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an affiliate with a destination url", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body(products: [listed(destination_url: "https://example.com/landing")]))

    expect(response).to have_http_status(:see_other)
  end

  it "refuses an affiliate with a fee above the allowed range", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body(products: [listed(fee_percent: 90)]))

    expect(response).to have_http_status(:found)
    expect(response.location).to end_with(new_affiliate_path)
  end

  it "refuses an affiliate with a fee below the allowed range", parity: true do
    affiliate_user
    product
    log_in(seller)

    send_create(body(products: [listed(fee_percent: 0)]))

    expect(response).to have_http_status(:found)
    expect(response.location).to end_with(new_affiliate_path)
  end

  it "hands an affiliate for a product that is a collab", parity: true do
    affiliate_user
    product.is_collab = true
    product.save!(validate: false)
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
    expect(response.location).to end_with(affiliates_path)
  end

  it "hands an affiliate whose earlier row has no product and still holds the account", parity: true do
    affiliate_user
    product
    create(:direct_affiliate, seller:, affiliate_user:, products: [product]).product_affiliates.delete_all
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:found)
    expect(response.location).to end_with(new_affiliate_path)
  end

  it "hands an affiliate with a Brazilian merchant account", parity: true do
    affiliate_user
    product
    create(:merchant_account_stripe_connect, user: affiliate_user, country: "BR")
    log_in(seller)

    send_create(body)

    expect(response).to have_http_status(:see_other)
  end
end
