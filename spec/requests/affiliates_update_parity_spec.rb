# frozen_string_literal: true

require "spec_helper"

# PATCH /affiliates/:id (AffiliatesController#update) when it saves an edit that keeps the affiliate, its account and its one product and
# moves fees: the UPDATE of the affiliate and of its assignment, and `AffiliateMailer.notify_direct_affiliate_of_updated_products(id)
# .deliver_later` when the product's fee moved. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/affiliates-update.replay.test.ts, which sends the last request of each example.
#
# `parity_mail_jobs` records the mail enqueue (the test adapter would swallow it), `parity_timeline` the order of the statements and
# jobs. An example named "hands a ..." records what Node passes to Rails whole: the shape is not proven.
describe "Affiliates update", type: :request, parity_timeline: true, parity_mail_jobs: true, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:product) { create(:product, user: seller, name: "Affiliate product") }
  let(:other_product) { create(:product, user: seller, name: "Second affiliate product") }
  let(:affiliate_user) { create(:named_user, name: "Parity Affiliate") }
  let(:direct_affiliate) { create(:direct_affiliate, seller:, affiliate_user:, products: [product], affiliate_basis_points: 1000) }

  before { host! DOMAIN }

  # A page render is slow the first time: fetch the token before creating rows when their age matters to the recording.
  def send_update(affiliate, body, token: csrf_token)
    patch affiliate_path(affiliate.external_id),
          params: body.to_json,
          headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => token }
  end

  def listed(target = product, fee_percent: 10, destination_url: nil)
    { id: target.external_id_numeric, enabled: true, fee_percent:, destination_url: }
  end

  def body(products: [listed], email: affiliate_user.email, fee_percent: nil, destination_url: nil, apply_to_all_products: false)
    { affiliate: { email:, apply_to_all_products:, fee_percent:, destination_url:, products: } }
  end

  # The assignment the factory builds carries no fee of its own.
  def price_assignment(affiliate, basis_points)
    affiliate.product_affiliates.update_all(affiliate_basis_points: basis_points)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "moves the product's fee and queues the update mail", parity: true do
    price_assignment(direct_affiliate, 500)
    log_in(seller)

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
    expect(response.location).to eq(affiliates_url)
    expect(direct_affiliate.product_affiliates.first.reload.affiliate_basis_points).to eq(1000)
  end

  it "fills in the fee of an assignment that had none", parity: true do
    log_in(seller)
    direct_affiliate

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
    expect(direct_affiliate.product_affiliates.first.reload.affiliate_basis_points).to eq(1000)
  end

  it "moves only the affiliate's fee through the top-level percentage without mailing", parity: true do
    price_assignment(direct_affiliate, 1000)
    log_in(seller)

    send_update(direct_affiliate, body(fee_percent: 25))

    expect(response).to have_http_status(:see_other)
    expect(direct_affiliate.reload.affiliate_basis_points).to eq(2500)
  end

  it "saves an edit that changes nothing", parity: true do
    price_assignment(direct_affiliate, 1000)
    log_in(seller)

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
  end

  it "lets an admin team member edit an affiliate", parity: true do
    price_assignment(direct_affiliate, 500)
    as_team_member(TeamMembership::ROLE_ADMIN)

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
  end

  it "edits an affiliate who turned posts off", parity: true do
    log_in(seller)
    token = csrf_token
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product], affiliate_basis_points: 1000, send_posts: false)
    price_assignment(affiliate, 500)

    send_update(affiliate, body, token:)

    expect(response).to have_http_status(:see_other)
    expect(affiliate.reload.send_posts).to be(false)
  end

  it "hands an edit that moves the affiliation to another account", parity: true do
    other_user = create(:named_user, name: "Other Affiliate")
    price_assignment(direct_affiliate, 500)
    log_in(seller)

    send_update(direct_affiliate, body(email: other_user.email))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit that adds a product", parity: true do
    price_assignment(direct_affiliate, 500)
    other_product
    log_in(seller)

    send_update(direct_affiliate, body(products: [listed, listed(other_product, fee_percent: 15)]))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit that switches to another product", parity: true do
    price_assignment(direct_affiliate, 500)
    other_product
    log_in(seller)

    send_update(direct_affiliate, body(products: [listed(other_product)]))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit that turns on all products", parity: true do
    price_assignment(direct_affiliate, 500)
    log_in(seller)

    send_update(direct_affiliate, body(apply_to_all_products: true, fee_percent: 20))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit that sets a destination url", parity: true do
    price_assignment(direct_affiliate, 500)
    log_in(seller)

    send_update(direct_affiliate, body(products: [listed(destination_url: "https://example.com/landing")]))

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit of an affiliate that already has a destination url", parity: true do
    price_assignment(direct_affiliate, 500)
    direct_affiliate.update_column(:destination_url, "https://example.com/landing")
    log_in(seller)

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
  end

  it "hands an edit to a fee above the allowed range", parity: true do
    price_assignment(direct_affiliate, 500)
    log_in(seller)

    send_update(direct_affiliate, body(fee_percent: 90))

    expect(response).to have_http_status(:see_other)
    expect(response.location).to end_with("/affiliates/#{direct_affiliate.external_id}/edit")
  end

  it "refuses an edit onto an account the seller has as another live affiliate", parity: true do
    price_assignment(direct_affiliate, 500)
    build(:direct_affiliate, seller:, affiliate_user:, products: [other_product]).save!(validate: false)
    log_in(seller)

    send_update(direct_affiliate, body)

    expect(response).to have_http_status(:see_other)
    expect(response.location).to end_with("/affiliates/#{direct_affiliate.external_id}/edit")
  end
end
