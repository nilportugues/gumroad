# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::PurchasesController through the whole stack, on the API host with a per-actor token. Recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are
# requests the port leaves to Rails (refunds, mail, subscription cancellation, buyer blocks, Stripe lookups): the replay asserts they
# reach the stand-in Rails untouched and write nothing. The money and mail methods are stubbed so recording needs no processor.
describe "Internal admin API purchases", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com", name: "Seller Name") }
  let(:product) { create(:product, user: seller, name: "Guide", price_cents: 1500) }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  def create_purchase(**attributes)
    defaults = { seller:, link: product, email: "buyer@example.com", price_cents: 1500, purchase_state: "successful", charge_processor_id: "paypal", stripe_transaction_id: "PAYPAL-TXN-1", merchant_account: nil, created_at: 3.days.ago }
    build(:purchase, **defaults, **attributes).tap { _1.save!(validate: false) }
  end

  # Card columns are written after the save: a card_visual on a new row runs the fraud checks, which parse it as an email.
  def create_card_purchase(card_type:, card_visual:, stripe_fingerprint:, **attributes)
    create_purchase(**attributes).tap { _1.update_columns(card_type:, card_visual:, stripe_fingerprint:) }
  end

  def create_refund(purchase, amount_cents:, **attributes)
    build(:refund, purchase:, amount_cents:, **attributes).tap { _1.save!(validate: false) }
  end

  describe "GET show" do
    it "serializes a purchase with its refund, dispute, early fraud warning, affiliate credit, ping deliveries and clusters", parity: true do
      purchase = create_purchase(ip_address: "203.0.113.7", ip_country: "France", country: "United States", card_country: "GB", stripe_partially_refunded: true, chargeback_date: 1.day.ago)
      create_purchase(email: "other@example.com", ip_address: "203.0.113.7", stripe_fingerprint: "other-fingerprint", created_at: 4.days.ago)
      create_refund(purchase, amount_cents: 500)
      create(:dispute, purchase:, state: :formalized, reason: Dispute::REASON_FRAUDULENT, charge_processor_dispute_id: "dp_1", initiated_at: 2.days.ago, formalized_at: 1.day.ago)
      create(:early_fraud_warning, purchase:, resolution: "resolved_ignored", resolved_at: 1.hour.ago)
      credit = build(:affiliate_credit, purchase:, affiliate_user: create(:user, email: "affiliate@example.com"), amount_cents: 150, fee_cents: 15)
      credit.save!(validate: false)
      create(:ping_delivery, user: seller, purchase:, post_url: "https://example.com/older", created_at: 2.hours.ago)
      create(:ping_delivery, user: seller, purchase:, response_code: nil, error_class: "Net::ReadTimeout", succeeded: false, attempt: 2, created_at: 1.hour.ago)

      get "/internal/admin/purchases/#{purchase.external_id_numeric}", headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]).to include("refund_status" => "partially_refunded", "refund_amount" => 500, "currency_type" => "usd")
      expect(response.parsed_body["purchase"]["ping_deliveries"].size).to eq(2)
    end

    it "serializes a fully refunded purchase in a non-USD currency", parity: true do
      purchase = create_purchase(displayed_price_currency_type: "eur", displayed_price_cents: 1400, rate_converted_to_usd: "0.9333", stripe_refunded: true, email: "buyer@example.com")
      create_refund(purchase, amount_cents: 1500)

      get "/internal/admin/purchases/#{purchase.external_id_numeric}", headers: headers

      expect(response.parsed_body["purchase"]).to include("refund_status" => "refunded", "currency_type" => "eur", "amount_refundable_cents_in_currency" => 0)
    end

    it "serializes a purchase without a seller card, dispute or refund", parity: true do
      purchase = create_purchase(price_cents: 0, stripe_transaction_id: nil, charge_processor_id: nil, card_type: nil, card_visual: nil, card_country: nil, stripe_fingerprint: nil)

      get "/internal/admin/purchases/#{purchase.external_id_numeric}", headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]).to include("dispute" => nil, "early_fraud_warning" => nil, "affiliate_credit" => nil, "amount_refundable_cents_in_currency" => 0)
    end

    it "answers 404 for an id that is not numeric", parity: true do
      get "/internal/admin/purchases/abc", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a purchase that does not exist", parity: true do
      get "/internal/admin/purchases/123456", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a purchase charged through Stripe to Rails", parity: true do
      purchase = create_purchase(charge_processor_id: "stripe", stripe_transaction_id: "ch_stripe_1")
      allow(Radar::ChargeRiskLevelService).to receive(:fetch).and_return("normal")

      get "/internal/admin/purchases/#{purchase.external_id_numeric}", headers: headers

      expect(response.parsed_body["purchase"]["stripe_risk_level"]).to eq("normal")
    end
  end

  describe "GET search" do
    let!(:purchase) { create_purchase(created_at: 2.days.ago) }
    let!(:newer) { create_purchase(created_at: 1.day.ago, email: "other@example.com", link: create(:product, user: seller, name: "Workbook")) }

    it "finds the purchases of a buyer email, newest first", parity: true do
      create_purchase(created_at: 12.hours.ago)

      get "/internal/admin/purchases/search", params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("count" => 2, "has_more" => false, "limit" => 25)
    end

    it "finds a purchase by its external id, narrowed by product title and status", parity: true do
      get "/internal/admin/purchases/search", params: { query: purchase.external_id, product_title_query: "Gui", purchase_status: "successful" }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([purchase.external_id_numeric.to_s])
    end

    it "finds the purchase a gift was sent to", parity: true do
      gift = build(:gift, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", gifter_purchase: purchase, giftee_purchase: newer, link: product)
      gift.save!(validate: false)

      get "/internal/admin/purchases/search", params: { query: "giftee@example.com" }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([newer.external_id_numeric.to_s])
    end

    it "finds a purchase by its numeric id", parity: true do
      get "/internal/admin/purchases/search", params: { query: purchase.id.to_s }, headers: headers

      expect(response.parsed_body["count"]).to eq(1)
    end

    it "limits the results and reports that more exist", parity: true do
      get "/internal/admin/purchases/search", params: { creator_email: "seller@example.com", limit: 1 }, headers: headers

      expect(response.parsed_body).to include("count" => 1, "limit" => 1, "has_more" => true)
    end

    it "narrows by a refunded or chargeback status", parity: true do
      create_refund(newer, amount_cents: 1500)
      newer.update_columns(stripe_refunded: true)

      get "/internal/admin/purchases/search", params: { query: "other@example.com", purchase_status: "refunded" }, headers: headers
      refunded = response.parsed_body["purchases"].map { _1["id"] }
      get "/internal/admin/purchases/search", params: { query: "other@example.com", purchase_status: "chargeback" }, headers: headers

      expect(refunded).to eq([newer.external_id_numeric.to_s])
      expect(response.parsed_body["count"]).to eq(0)
    end

    it "finds a purchase by license key", parity: true do
      create(:license, purchase:, link: product)

      get "/internal/admin/purchases/search", params: { license_key: License.find_by!(purchase_id: purchase.id).serial }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([purchase.external_id_numeric.to_s])
    end

    it "answers an empty list for a creator email with no account", parity: true do
      get "/internal/admin/purchases/search", params: { creator_email: "nobody@example.com" }, headers: headers

      expect(response.parsed_body).to include("count" => 0, "purchases" => [])
    end

    it "requires a query when product_title_query or purchase_status is given", parity: true do
      get "/internal/admin/purchases/search", params: { product_title_query: "Gui" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "requires at least one search parameter", parity: true do
      get "/internal/admin/purchases/search", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses an unknown purchase status", parity: true do
      get "/internal/admin/purchases/search", params: { query: "buyer@example.com", purchase_status: "pending" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "searches by the last four digits of the card in each visual format, newest first, skipping purchases with no fingerprint", parity: true do
      sixteen = create_card_purchase(card_type: "visa", card_visual: "**** **** **** 4062", stripe_fingerprint: "fp-1", created_at: 5.days.ago)
      fifteen = create_card_purchase(card_type: "american_express", card_visual: "**** ****** *4062", stripe_fingerprint: "fp-2", created_at: 4.days.ago)
      fourteen = create_card_purchase(card_type: "diners_club", card_visual: "**** ****** 4062", stripe_fingerprint: "fp-3", created_at: 3.days.ago)
      create_card_purchase(card_type: "visa", card_visual: "**** **** **** 4242", stripe_fingerprint: "fp-4", created_at: 2.days.ago)
      create_card_purchase(card_type: "visa", card_visual: "**** **** **** 4062", stripe_fingerprint: nil, created_at: 1.day.ago)

      get "/internal/admin/purchases/search", params: { email: "buyer@example.com", card_last4: "4062" }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([fourteen, fifteen, sixteen].map { _1.external_id_numeric.to_s })
    end

    it "narrows a card search by card type and by a charge amount within a quarter either side", parity: true do
      create_card_purchase(card_type: "visa", card_visual: "**** **** **** 4062", stripe_fingerprint: "fp-1", price_cents: 1000, created_at: 5.days.ago)
      match = create_card_purchase(card_type: "visa", card_visual: "**** **** **** 1111", stripe_fingerprint: "fp-2", price_cents: 2562, created_at: 4.days.ago)
      create_card_purchase(card_type: "visa", card_visual: "**** **** **** 2222", stripe_fingerprint: "fp-3", price_cents: 2563, created_at: 3.days.ago)
      create_card_purchase(card_type: "mastercard", card_visual: "**** **** **** 3333", stripe_fingerprint: "fp-4", price_cents: 2000, created_at: 2.days.ago)

      get "/internal/admin/purchases/search", params: { card_type: "visa", charge_amount: "20.50" }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([match.external_id_numeric.to_s])
    end

    it "refuses a card last four digits search with nothing to narrow it", parity: true do
      get "/internal/admin/purchases/search", params: { card_last4: "4062" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a card search by purchase date to Rails", parity: true do
      get "/internal/admin/purchases/search", params: { email: "buyer@example.com", purchase_date: "2026-01-15" }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a card search by expiry date to Rails", parity: true do
      get "/internal/admin/purchases/search", params: { email: "buyer@example.com", expiry_date: "04/27" }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a search that reaches a Stripe charge to Rails", parity: true do
      create_purchase(email: "stripe@example.com", charge_processor_id: "stripe", stripe_transaction_id: "ch_stripe_2")
      allow(Radar::ChargeRiskLevelService).to receive(:fetch_bulk).and_return({})

      get "/internal/admin/purchases/search", params: { email: "stripe@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET lookup" do
    it "pages the purchases that share an ip address with a signed cursor", parity: true do
      create_purchase(ip_address: "203.0.113.9", created_at: 2.hours.ago)
      create_purchase(ip_address: "203.0.113.9", created_at: 1.hour.ago, email: "second@example.com")
      create_purchase(ip_address: "203.0.113.10", created_at: 30.minutes.ago)

      get "/internal/admin/purchases/lookup", params: { ip_address: "203.0.113.9", limit: 1 }, headers: headers
      cursor = response.parsed_body["pagination"]["next"]
      get "/internal/admin/purchases/lookup", params: { ip_address: "203.0.113.9", limit: 1, cursor: }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["email"] }).to eq(["buyer@example.com"])
      expect(response.parsed_body["pagination"]["next"]).to be_nil
    end

    it "looks up a browser guid and a card fingerprint", parity: true do
      create_purchase(browser_guid: "guid-1", stripe_fingerprint: "fingerprint-1")

      get "/internal/admin/purchases/lookup", params: { browser_guid: "guid-1" }, headers: headers
      by_guid = response.parsed_body["purchases"].size
      get "/internal/admin/purchases/lookup", params: { stripe_fingerprint: "fingerprint-1" }, headers: headers

      expect(by_guid).to eq(1)
      expect(response.parsed_body["lookup"]).to eq("field" => "stripe_fingerprint", "value" => "fingerprint-1")
    end

    it "answers an empty list for an unknown ip address", parity: true do
      get "/internal/admin/purchases/lookup", params: { ip_address: "198.51.100.1" }, headers: headers

      expect(response.parsed_body["purchases"]).to eq([])
    end

    it "requires one of the lookup fields", parity: true do
      get "/internal/admin/purchases/lookup", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses more than one lookup field", parity: true do
      get "/internal/admin/purchases/lookup", params: { ip_address: "203.0.113.9", browser_guid: "guid-1" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses a cursor Rails did not sign", parity: true do
      get "/internal/admin/purchases/lookup", params: { ip_address: "203.0.113.9", cursor: "garbage" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a lookup that reaches a Stripe charge to Rails", parity: true do
      create_purchase(ip_address: "203.0.113.11", charge_processor_id: "stripe", stripe_transaction_id: "ch_stripe_3")
      allow(Radar::ChargeRiskLevelService).to receive(:fetch_bulk).and_return({})

      get "/internal/admin/purchases/lookup", params: { ip_address: "203.0.113.11" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST resend_receipt" do
    it "answers 404 for an unknown purchase", parity: true do
      post "/internal/admin/purchases/123456/resend_receipt", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a receipt resend to Rails", parity: true do
      purchase = create_purchase
      allow_any_instance_of(Purchase).to receive(:resend_receipt)

      post "/internal/admin/purchases/#{purchase.external_id_numeric}/resend_receipt", headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST resend_all_receipts" do
    it "requires an email", parity: true do
      post "/internal/admin/purchases/resend_all_receipts", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 when the email has no successful purchase", parity: true do
      create_purchase(email: "failed@example.com", purchase_state: "failed")

      post "/internal/admin/purchases/resend_all_receipts", params: { email: "failed@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a grouped receipt to Rails", parity: true do
      create_purchase

      post "/internal/admin/purchases/resend_all_receipts", params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST refund_taxes" do
    it "requires an email", parity: true do
      post "/internal/admin/purchases/123456/refund_taxes", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 when the email is not the buyer's", parity: true do
      purchase = create_purchase

      post "/internal/admin/purchases/#{purchase.external_id_numeric}/refund_taxes", params: { email: "someone@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a tax refund to Rails", parity: true do
      purchase = create_purchase
      allow_any_instance_of(Purchase).to receive(:refund_gumroad_taxes!).and_return(false)

      post "/internal/admin/purchases/#{purchase.external_id_numeric}/refund_taxes", params: { email: " Buyer@Example.com " }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end

  describe "POST refund" do
    let!(:purchase) { create_purchase(created_at: 2.days.ago) }
    let(:path) { "/internal/admin/purchases/#{purchase.external_id_numeric}/refund" }
    let(:refundable) { { email: "buyer@example.com", reason: "Duplicate charge" } }

    before { create(:purchase_refund_policy, purchase:, fine_print: nil) }

    it "requires an email", parity: true do
      post path, params: { reason: "Duplicate charge" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "requires a reason", parity: true do
      post path, params: { email: "buyer@example.com", reason: "  " }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 when the email is not the buyer's", parity: true do
      post path, params: refundable.merge(email: "someone@example.com"), headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a purchase that is already fully refunded", parity: true do
      purchase.update_columns(stripe_refunded: true)

      post path, params: refundable, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a purchase with no charge to refund", parity: true do
      purchase.update_columns(stripe_transaction_id: nil)

      post path, params: refundable, headers: headers

      expect(response.parsed_body["message"]).to eq("Purchase has no charge to refund")
    end

    it "refuses a purchase whose refunds already cover the price", parity: true do
      create_refund(purchase, amount_cents: 1500)

      post path, params: refundable, headers: headers

      expect(response.parsed_body["message"]).to eq("Purchase has no charge to refund")
    end

    it "refuses a purchase outside its refund policy timeframe", parity: true do
      purchase.update_columns(created_at: 45.days.ago)

      post path, params: refundable, headers: headers

      expect(response.parsed_body["message"]).to eq("Purchase is outside of the refund policy timeframe")
    end

    it "refuses a purchase with no recorded refund policy", parity: true do
      purchase.purchase_refund_policy.destroy!

      post path, params: refundable, headers: headers

      expect(response.parsed_body["message"]).to eq("Purchase has no recorded refund policy")
    end

    it "refuses a purchase whose refund policy has fine print", parity: true do
      purchase.purchase_refund_policy.update_columns(fine_print: "Seller review required")

      post path, params: refundable, headers: headers

      expect(response.parsed_body["message"]).to eq("This product has specific refund conditions that require seller review")
    end

    it "refuses an amount that is not a positive integer", parity: true do
      post path, params: refundable.merge(amount_cents: "12.5"), headers: headers
      fractional = response.parsed_body["message"]
      post path, params: refundable.merge(amount_cents: "0"), headers: headers

      expect(fractional).to eq("amount_cents must be a positive integer")
      expect(response.parsed_body["message"]).to eq("amount_cents must be a positive integer")
    end

    it "checks the amount of a forced refund after skipping the policy", parity: true do
      purchase.update_columns(created_at: 45.days.ago)

      post path, params: refundable.merge(force: "true", amount_cents: "-5"), headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a refund to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:refund!).and_return(true)

      post path, params: refundable.merge(amount_cents: "500"), headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a forced refund outside the policy to Rails", parity: true do
      purchase.update_columns(created_at: 45.days.ago)
      allow_any_instance_of(Purchase).to receive(:refund!).and_return(true)

      post path, params: refundable.merge(force: "true"), headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST cancel_subscription" do
    let(:membership) { create(:membership_product, user: seller) }
    let(:subscription) { create(:subscription, link: membership, user: nil) }
    let!(:purchase) { create_purchase(link: membership, subscription:, is_original_subscription_purchase: true) }
    let(:path) { "/internal/admin/purchases/#{purchase.external_id_numeric}/cancel_subscription" }

    it "requires an email", parity: true do
      post path, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 when the email is not the buyer's", parity: true do
      post path, params: { email: "someone@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a purchase with no subscription", parity: true do
      other = create_purchase(email: "plain@example.com")

      post "/internal/admin/purchases/#{other.external_id_numeric}/cancel_subscription", params: { email: "plain@example.com" }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "reports a subscription that is already cancelled", parity: true do
      subscription.update_columns(cancelled_at: 2.days.ago, deactivated_at: 1.day.ago, flags: subscription.flags | 4)

      post path, params: { email: "buyer@example.com" }, headers: headers

      expect(response.parsed_body).to include("status" => "already_cancelled", "cancelled_by_admin" => true)
    end

    it "reports a subscription that is no longer active", parity: true do
      subscription.update_columns(failed_at: 2.days.ago, deactivated_at: 1.day.ago)

      post path, params: { email: "buyer@example.com" }, headers: headers

      expect(response.parsed_body).to include("status" => "already_inactive", "termination_reason" => "failed_payment")
    end

    it "hands a cancellation to Rails", parity: true do
      allow_any_instance_of(Subscription).to receive(:cancel!)

      post path, params: { email: "buyer@example.com", by_seller: "true" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST block_buyer and unblock_buyer" do
    let!(:purchase) { create_purchase }

    it "requires an email to block", parity: true do
      post "/internal/admin/purchases/#{purchase.external_id_numeric}/block_buyer", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 when the email to unblock is not the buyer's", parity: true do
      post "/internal/admin/purchases/#{purchase.external_id_numeric}/unblock_buyer", params: { email: "someone@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a buyer block to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:block_buyer!)

      post "/internal/admin/purchases/#{purchase.external_id_numeric}/block_buyer", params: { email: "buyer@example.com", comment_content: "Chargeback abuse" }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a buyer unblock to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:buyer_blocked?).and_return(false)

      post "/internal/admin/purchases/#{purchase.external_id_numeric}/unblock_buyer", params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST refund_for_fraud" do
    let!(:purchase) { create_purchase }
    let(:path) { "/internal/admin/purchases/#{purchase.external_id_numeric}/refund_for_fraud" }

    it "answers 404 when the email is not the buyer's", parity: true do
      post path, params: { email: "someone@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a purchase that is already fully refunded", parity: true do
      purchase.update_columns(stripe_refunded: true)

      post path, params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a purchase with no charge to refund", parity: true do
      purchase.update_columns(stripe_transaction_id: nil)

      post path, params: { email: "buyer@example.com" }, headers: headers

      expect(response.parsed_body["message"]).to eq("Purchase has no charge to refund")
    end

    it "hands a refund for fraud to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:refund_for_fraud_and_block_buyer!).and_return(true)

      post path, params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end
end
