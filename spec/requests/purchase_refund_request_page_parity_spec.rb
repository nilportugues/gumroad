# frozen_string_literal: true

require "spec_helper"

# GET /purchases/:purchase_id/refund_request (Purchases::RefundRequestsController#show), recorded for the Next.js port
# (PARITY_RECORD=1). It only reads: the form is a POST that creates a request and queues mail, which stays in Rails.
# Purchases are built without a charge (no processor is called).
describe "Purchase refund request page", type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:seller) { create(:user, name: "Refund Seller") }
  let(:product) { create(:product, user: seller, name: "Refundable thing", price_cents: 1_500) }
  let(:purchase) do
    build(:purchase, link: product, seller:, email: "buyer@example.com", price_cents: 1_500, purchase_state: "successful").tap { _1.save!(validate: false) }
  end
  let(:token) { purchase.secure_external_id(scope: PurchaseRefundRequest::SECURE_ID_SCOPE, expires_at: PurchaseRefundRequest::LINK_EXPIRY.from_now) }

  before do
    host! DOMAIN
    Feature.activate_user(:buyer_refund_requests, seller)
  end

  def show = get("/purchases/#{token}/refund_request")

  it "renders the form for an eligible purchase", parity: true do
    show

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to eq("no-store")
  end

  it "shows the request a buyer made", parity: true do
    create(:purchase_refund_request, purchase:, reason: "other")

    show

    expect(response).to have_http_status(:ok)
  end

  it "shows an escalated request and its own deadline", parity: true do
    travel_to(Time.utc(2026, 11, 4, 12)) { create(:purchase_refund_request, purchase:, reason: "not_received", escalated_at: Time.utc(2026, 11, 9, 12)) }

    show

    expect(response).to have_http_status(:ok)
  end

  it "shows a request of a refunded purchase", parity: true do
    create(:purchase_refund_request, purchase:, reason: "duplicate_purchase")
    purchase.update_column(:stripe_refunded, true)

    show

    expect(response).to have_http_status(:ok)
  end

  it "shows a request of a disputed purchase", parity: true do
    create(:purchase_refund_request, purchase:)
    purchase.update_columns(stripe_partially_refunded: true, chargeback_date: Time.current)

    show

    expect(response).to have_http_status(:ok)
  end

  it "explains a partly refunded purchase", parity: true do
    purchase.update_column(:stripe_partially_refunded, true)

    show

    expect(response).to have_http_status(:ok)
  end

  it "explains a purchase outside the refund window", parity: true do
    create(:purchase_refund_policy, purchase:, max_refund_period_in_days: 30)
    purchase.update_column(:created_at, 40.days.ago)

    show

    expect(response).to have_http_status(:ok)
  end

  it "explains a seller who offers no refunds", parity: true do
    create(:purchase_refund_policy, purchase:, max_refund_period_in_days: 0)

    show

    expect(response).to have_http_status(:ok)
  end

  it "explains a free purchase", parity: true do
    purchase.update_column(:price_cents, 0)

    show

    expect(response).to have_http_status(:ok)
  end

  # The price of a subscription charge carries a recurrence label Node does not format, so the page goes to Rails whole.
  it "hands a renewal of a subscription to Rails, which takes its refund window from the original purchase", parity: true do
    subscription_product = create(:membership_product, user: seller, name: "Monthly refundable")
    subscription = create(:subscription, link: subscription_product, user: nil)
    original = build(:purchase, link: subscription_product, seller:, subscription:, is_original_subscription_purchase: true, price_cents: 1_500, purchase_state: "successful", email: "member@example.com").tap { _1.save!(validate: false) }
    create(:purchase_refund_policy, purchase: original, max_refund_period_in_days: 14)
    renewal = build(:purchase, link: subscription_product, seller:, subscription:, price_cents: 1_500, purchase_state: "successful", email: "member@example.com").tap { _1.save!(validate: false) }
    renewal.update_column(:created_at, 20.days.ago)

    get "/purchases/#{renewal.secure_external_id(scope: PurchaseRefundRequest::SECURE_ID_SCOPE, expires_at: PurchaseRefundRequest::LINK_EXPIRY.from_now)}/refund_request"

    expect(response).to have_http_status(:ok)
  end

  it "answers 404 when the seller does not have the feature", parity: true do
    Feature.deactivate_user(:buyer_refund_requests, seller)

    show

    expect(response).to have_http_status(:not_found)
  end
end
