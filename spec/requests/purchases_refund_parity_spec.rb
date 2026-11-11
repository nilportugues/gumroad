# frozen_string_literal: true

require "spec_helper"

# PUT /purchases/:id/refund, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchases-refund.replay.test.ts. Stripe's answers are read back out of existing VCR cassettes and served
# by WebMock, so nothing leaves the machine. For an example that reaches Stripe the fixture also holds each call's headers and an
# ordered timeline of the writes and calls (Parity::Recorder), which the replay checks against a stand-in Stripe: a refusal made
# before the processor is called must write nothing and call nothing, and an example named "hands a ..." must leave the whole
# request, Stripe call and ledger included, to Rails.
describe "Refunding a Stripe purchase", type: :request do
  include Parity::AudienceSignedIn

  CASSETTES = Rails.root.join("spec/support/fixtures/vcr_cassettes/PurchasesController/within_seller_area/refund")
  FULL_REFUND_CASSETTE = CASSETTES.join("issues_a_full_refund_when_total_amount_is_passed_as_param.yml")
  PARTIAL_REFUND_CASSETTE = CASSETTES.join("issues_a_partial_refund_when_partial_amount_is_passed_as_param.yml")

  let(:unpaid_balance_cents) { 200 }
  let(:seller_attributes) { {} }
  let(:seller) { create(:user, name: "Refund Seller", username: "refundseller", unpaid_balance_cents:, created_at: Time.utc(2025, 1, 1), **seller_attributes) }
  let(:product) { create(:product, user: seller, name: "Refunded product", unique_permalink: "refunded", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/customers" }
  end

  before do
    host! DOMAIN
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
  end

  # Every interaction of the cassette, answered as Stripe answered it when the cassette was recorded.
  def stub_stripe_from_cassette(path)
    YAML.safe_load_file(path, permitted_classes: [Symbol])["http_interactions"].each do |interaction|
      request = interaction["request"]
      response = interaction["response"]
      stub_request(request["method"].to_sym, request["uri"]).to_return(
        status: response["status"]["code"],
        body: response["body"]["string"],
        headers: { "Content-Type" => response["headers"]["Content-Type"].first }
      )
    end
  end

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  # Charged through the stubbed Stripe cassette, so a refund of it has the answers it needs.
  def stripe_purchase
    purchase = create(:purchase_in_progress, link: product, seller:, price_cents: 100, total_transaction_cents: 100, fee_cents: 30, chargeable: create(:chargeable))
    purchase.process!
    purchase.mark_successful!
    purchase
  end

  # A sale that never reached Stripe: the refusals that come before the processor need only its row.
  def stored_purchase(**attributes)
    gumroad_account = MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id)
    build(:purchase, link: product, seller:, email: "buyer@example.com", price_cents: 100, total_transaction_cents: 100, fee_cents: 30,
                     purchase_state: "successful", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account: gumroad_account,
                     stripe_transaction_id: "ch_refund_guard", **attributes).tap { _1.save!(validate: false) }
  end

  def refund(purchase, body = {})
    log_in(seller)
    send_json(:put, "/purchases/#{purchase.external_id}/refund", body)
  end

  describe "a refund Rails takes through Stripe" do
    it "hands a full refund of a Stripe purchase to Rails", parity: true do
      stub_stripe_from_cassette(FULL_REFUND_CASSETTE)
      purchase = stripe_purchase

      refund(purchase)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "partially_refunded" => false)
      expect(purchase.reload.stripe_refunded).to be(true)
    end

    it "hands a refund with an amount to Rails", parity: true do
      stub_stripe_from_cassette(PARTIAL_REFUND_CASSETTE)
      purchase = stripe_purchase

      refund(purchase, { amount: "0.50" })

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => true)
    end

    it "hands a refund by a Gumroad team member to Rails", parity: true do
      stub_stripe_from_cassette(FULL_REFUND_CASSETTE)
      purchase = stripe_purchase
      seller.update!(is_team_member: true)

      refund(purchase)

      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "a refund Rails refuses before it calls Stripe" do
    it "refuses an amount with a comma", parity: true do
      refund(stored_purchase, { amount: "1,00" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false, "message" => "Commas not supported in refund amount.")
    end

    it "answers 404 for a purchase that is already refunded", parity: true do
      refund(stored_purchase(stripe_refunded: true))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 for another seller's purchase", parity: true do
      other = create(:product, unique_permalink: "notmine")
      foreign = build(:purchase, link: other, seller: other.user, purchase_state: "successful", stripe_transaction_id: "ch_foreign").tap { _1.save!(validate: false) }

      refund(foreign)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a free purchase", parity: true do
      refund(stored_purchase(price_cents: 0, total_transaction_cents: 0))

      expect(response).to have_http_status(:not_found)
    end

    it "says there is nothing to refund for a sale with no processor transaction", parity: true do
      refund(stored_purchase(stripe_transaction_id: nil))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false, "message" => "This purchase has already been refunded or has nothing left to refund.")
    end

    it "refuses a sale with an active dispute", parity: true do
      refund(stored_purchase(chargeback_date: 1.day.ago))

      expect(response.parsed_body).to eq(
        "success" => false,
        "message" => "This purchase has an active dispute. The funds have already been returned to the buyer. No additional refund is needed."
      )
    end

    it "refuses when the seller's account has refunds disabled", parity: true do
      seller.update!(refunds_disabled: true)

      refund(stored_purchase)

      expect(response.parsed_body).to eq("success" => false, "message" => "Refunds are temporarily disabled in your account.")
    end

    context "when the seller's balance is below the refund" do
      let(:unpaid_balance_cents) { 50 }

      it "refuses because the balance is insufficient", parity: true do
        refund(stored_purchase)

        expect(response.parsed_body).to eq("success" => false, "message" => "Your balance is insufficient to process this refund.")
      end
    end
  end
end
