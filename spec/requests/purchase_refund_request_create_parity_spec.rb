# frozen_string_literal: true

require "spec_helper"

# POST /purchases/:purchase_id/refund_request (Purchases::RefundRequestsController#create), sent the way the Inertia form does and
# recorded for the Next.js port (PARITY_RECORD=1); nextjs/parity/__tests__/purchase-refund-request.replay.test.ts replays the last
# request of each example. An example named "hands a ..." is one Node leaves to Rails whole. Purchases are built without a charge.
describe "Purchase refund request create", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Refund Seller") }
  let(:product) { create(:product, user: seller, name: "Refundable thing", price_cents: 1_500) }
  let(:purchase) do
    build(:purchase, link: product, seller:, email: "buyer@example.com", price_cents: 1_500, purchase_state: "successful").tap { _1.save!(validate: false) }
  end
  let(:token) { purchase.secure_external_id(scope: PurchaseRefundRequest::SECURE_ID_SCOPE, expires_at: PurchaseRefundRequest::LINK_EXPIRY.from_now) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json",
      "Referer" => "http://#{DOMAIN}/purchases/#{token}/refund_request" }
  end

  before do
    host! DOMAIN
    Feature.activate_user(:buyer_refund_requests, seller)
  end

  def submit(id: token, **body)
    post "/purchases/#{id}/refund_request", params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def page_location(id = token) = "http://#{DOMAIN}/purchases/#{id}/refund_request"

  describe "an eligible purchase" do
    it "records the request and queues the seller and buyer emails", parity: true, parity_mail_jobs: true do
      submit(reason: "not_received", message: "It never arrived")

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq(page_location)
      request = purchase.reload.refund_request
      expect(request).to have_attributes(email: "buyer@example.com", reason: "not_received", message: "It never arrived")
    end

    it "strips the message", parity: true, parity_mail_jobs: true do
      submit(reason: "other", message: "  \n padded text \t ")

      expect(purchase.reload.refund_request.message).to eq("padded text")
    end

    it "stores a blank message as nil", parity: true, parity_mail_jobs: true do
      submit(reason: "no_longer_needed", message: "   ")

      expect(purchase.reload.refund_request.message).to be_nil
    end

    it "stores no message when none is sent", parity: true, parity_mail_jobs: true do
      submit(reason: "duplicate_purchase")

      expect(purchase.reload.refund_request.message).to be_nil
    end

    it "cuts the message to the maximum length", parity: true, parity_mail_jobs: true do
      submit(reason: "not_as_described", message: "é" * 2_100)

      expect(purchase.reload.refund_request.message).to eq("é" * PurchaseRefundRequest::MAX_MESSAGE_LENGTH)
    end

    it "keeps the first request when the form is submitted again", parity: true do
      create(:purchase_refund_request, purchase:, reason: "other", message: "First")

      submit(reason: "not_received", message: "Second")

      expect(response).to have_http_status(:see_other)
      expect(purchase.reload.refund_request).to have_attributes(reason: "other", message: "First")
    end

    it "takes a subscription renewal's refund window from the original purchase", parity: true do
      subscription_product = create(:membership_product, user: seller, name: "Monthly refundable")
      subscription = create(:subscription, link: subscription_product, user: nil)
      original = build(:purchase, link: subscription_product, seller:, subscription:, is_original_subscription_purchase: true, price_cents: 1_500, purchase_state: "successful", email: "member@example.com").tap { _1.save!(validate: false) }
      create(:purchase_refund_policy, purchase: original, max_refund_period_in_days: 14)
      renewal = build(:purchase, link: subscription_product, seller:, subscription:, price_cents: 1_500, purchase_state: "successful", email: "member@example.com").tap { _1.save!(validate: false) }
      renewal.update_column(:created_at, 20.days.ago)
      renewal_token = renewal.secure_external_id(scope: PurchaseRefundRequest::SECURE_ID_SCOPE, expires_at: PurchaseRefundRequest::LINK_EXPIRY.from_now)

      submit(id: renewal_token, reason: "other")

      expect(response).to have_http_status(:see_other)
      expect(renewal.reload.refund_request).to be_nil
    end
  end

  describe "a refused request" do
    it "sends the buyer back to the form with an alert for an unknown reason", parity: true do
      submit(reason: "changed_my_mind", message: "x")

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq(page_location)
      expect(flash[:alert]).to eq("Please select a reason for your refund request.")
      expect(purchase.reload.refund_request).to be_nil
    end

    it "sends the buyer back to the form with an alert when no reason is sent", parity: true do
      submit(message: "x")

      expect(flash[:alert]).to eq("Please select a reason for your refund request.")
    end

    it "records nothing for a free purchase", parity: true do
      purchase.update_column(:price_cents, 0)

      submit(reason: "other")

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq(page_location)
      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "records nothing for a refunded purchase", parity: true do
      purchase.update_column(:stripe_refunded, true)

      submit(reason: "other")

      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "records nothing for a disputed purchase", parity: true do
      purchase.update_column(:chargeback_date, Time.current)

      submit(reason: "other")

      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "records nothing for a partly refunded purchase", parity: true do
      purchase.update_column(:stripe_partially_refunded, true)

      submit(reason: "other")

      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "records nothing outside the refund window", parity: true do
      create(:purchase_refund_policy, purchase:, max_refund_period_in_days: 30)
      purchase.update_column(:created_at, 40.days.ago)

      submit(reason: "other")

      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "records nothing when the seller offers no refunds", parity: true do
      create(:purchase_refund_policy, purchase:, max_refund_period_in_days: 0)

      submit(reason: "other")

      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "answers 404 when the seller does not have the feature", parity: true do
      Feature.deactivate_user(:buyer_refund_requests, seller)

      submit(reason: "other")

      expect(response).to have_http_status(:not_found)
      expect(PurchaseRefundRequest.count).to eq(0)
    end

    it "answers 404 for a token of another scope", parity: true do
      other = purchase.secure_external_id(scope: "something_else", expires_at: 1.day.from_now)

      submit(id: other, reason: "other")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an expired token", parity: true do
      expired = purchase.secure_external_id(scope: PurchaseRefundRequest::SECURE_ID_SCOPE, expires_at: 1.day.ago)

      submit(id: expired, reason: "other")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a guessed id", parity: true do
      submit(id: "not-a-token", reason: "other")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "requests Node leaves to Rails" do
    it "hands a reason that is not text to Rails", parity: true do
      submit(reason: %w[other], message: "x")

      expect(response).to have_http_status(:see_other)
    end

    it "hands a message that is not text to Rails", parity: true, parity_mail_jobs: true do
      submit(reason: "other", message: { a: 1 })

      expect(response).to have_http_status(:see_other)
    end
  end
end
