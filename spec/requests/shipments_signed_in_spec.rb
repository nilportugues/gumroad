# frozen_string_literal: true

require "spec_helper"

# Marking an order as shipped from the customers page (ShipmentsController#mark_as_shipped), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12b.replay.test.ts.
describe "Marking orders as shipped when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Shipping Seller") }
  let(:product) { create(:physical_product, user: seller) }
  let(:purchase) { create(:physical_purchase, link: product, seller:) }
  let!(:shipment) { create(:shipment, purchase:) }
  let(:tracking_url) { "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=1234567890" }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def post_shipped(purchase_id, body = nil)
    token = csrf_token
    post mark_as_shipped_path(purchase_id), params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => token)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "marks the order as shipped", parity: true do
    log_in(seller)

    post_shipped(purchase.external_id)

    expect(response).to have_http_status(:no_content)
    expect(shipment.reload).to be_shipped
  end

  it "saves the tracking URL", parity: true do
    log_in(seller)

    post_shipped(purchase.external_id, tracking_url:)

    expect(response).to have_http_status(:no_content)
    expect(shipment.reload.tracking_url).to eq(tracking_url)
  end

  it "strips the tracking URL", parity: true do
    log_in(seller)

    post_shipped(purchase.external_id, tracking_url: "  #{tracking_url}  ")

    expect(response).to have_http_status(:no_content)
    expect(shipment.reload.tracking_url).to eq(tracking_url)
  end

  it "rejects a tracking value that is not a full URL", parity: true do
    log_in(seller)

    post_shipped(purchase.external_id, tracking_url: "1Z999AA10123456784")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("success" => false, "message" => "Tracking URL #{Shipment::VALID_TRACKING_LINK_MESSAGE}")
    expect(shipment.reload).not_to be_shipped
  end

  it "accepts a blank tracking URL", parity: true do
    log_in(seller)

    post_shipped(purchase.external_id, tracking_url: "")

    expect(response).to have_http_status(:no_content)
  end

  it "lets a support team member mark the order", parity: true do
    as_team_member(TeamMembership::ROLE_SUPPORT)

    post_shipped(purchase.external_id)

    expect(response).to have_http_status(:no_content)
  end

  it "does not let a marketing team member mark the order", parity: true do
    as_team_member(TeamMembership::ROLE_MARKETING)

    post_shipped(purchase.external_id)

    expect(response).to have_http_status(:unauthorized)
    expect(shipment.reload).not_to be_shipped
  end

  it "does not mark a digital purchase", parity: true do
    digital = create(:purchase, link: create(:product, user: seller), seller:)
    log_in(seller)

    post_shipped(digital.external_id)

    expect(response).to have_http_status(:unauthorized)
  end

  it "answers 404 for the purchase of another seller", parity: true do
    other = create(:physical_purchase, link: create(:physical_product))
    log_in(seller)

    post_shipped(other.external_id)

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
  end

  it "hands a purchase without a shipment to Rails", parity: true do
    without_shipment = create(:physical_purchase, link: product, seller:)
    log_in(seller)

    post_shipped(without_shipment.external_id, tracking_url:)

    expect(response).to have_http_status(:no_content)
    expect(without_shipment.reload.shipment).to be_shipped
  end
end
