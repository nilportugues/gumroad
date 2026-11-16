# frozen_string_literal: true

require "spec_helper"

# PUT /purchases/:id/refund once Stripe has been called, recorded for the Next.js port (PARITY_RECORD=1). What the sale looks
# like afterwards depends on which Stripe answer arrived: a refusal leaves no refund row and a message, a failed read of the
# refund Stripe just created leaves the money moved and nothing booked, a destination charge books the seller's leg from the
# connected account's balance transactions. `parity_timeline` records each write against the Stripe calls so the order is
# pinned. Stripe is WebMock only: every answer is built here, and nothing leaves the machine. A dropped connection is a
# call with `response.dropped`.
describe "Refunds after Stripe was called", type: :request, parity_timeline: true do
  include Parity::AudienceSignedIn

  STRIPE_API = "https://api.stripe.com/v1" unless defined?(STRIPE_API)
  JSON_HEADERS = { "Content-Type" => "application/json" }.freeze unless defined?(JSON_HEADERS)
  CHARGE_ID = "ch_parityrefund01"
  REFUND_ID = "re_parityrefund01"
  TRANSFER_ID = "tr_parityrefund01"
  DESTINATION_ACCOUNT = "acct_paritydest01"
  DESTINATION_PAYMENT_ID = "py_parityrefund01"

  let(:unpaid_balance_cents) { 200 }
  let(:seller) { create(:user, name: "Refund Seller", username: "refundseller", unpaid_balance_cents:, created_at: Time.utc(2025, 1, 1)) }
  let(:product) { create(:product, user: seller, name: "Refunded product", unique_permalink: "refunded", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/customers" }
  end

  before do
    host! DOMAIN
    # The suite retries a 429 up to twelve times (spec/support/stripe_rate_limit_retries.rb); the gem does not, and that is what a port sees.
    allow(Stripe::StripeClient).to receive(:should_retry?).and_wrap_original do |original, error, **options|
      error.is_a?(Stripe::RateLimitError) ? false : original.call(error, **options)
    end
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
  end

  def sale(**attributes)
    merchant_account = attributes.delete(:merchant_account) || MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id)
    build(:purchase, link: product, seller:, email: "buyer@example.com", price_cents: 100, total_transaction_cents: 100, fee_cents: 30, tax_cents: 0,
                     purchase_state: "successful", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:,
                     stripe_transaction_id: CHARGE_ID, **attributes).tap { _1.save!(validate: false) }.tap { _1.update_columns(price_cents: 100, total_transaction_cents: 100, fee_cents: 30, **attributes.slice(:price_cents, :total_transaction_cents, :fee_cents)) }
  end

  def send_refund(purchase, body = {})
    log_in(seller)
    put "/purchases/#{purchase.external_id}/refund", params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  # An error no controller rescues: the test environment raises it, production answers 500.
  def send_refund_unhandled(purchase, body = {})
    previous = Rails.application.env_config["action_dispatch.show_exceptions"]
    Rails.application.env_config["action_dispatch.show_exceptions"] = :all
    send_refund(purchase, body)
  ensure
    Rails.application.env_config["action_dispatch.show_exceptions"] = previous
  end

  def stripe_error(message, type: "invalid_request_error", code: nil)
    { error: { message:, type:, code: }.compact }.to_json
  end

  def balance_transaction_json(id, amount, net: amount, fee: 0, currency: "usd")
    { id:, object: "balance_transaction", amount:, net:, fee:, currency: }
  end

  def refund_json(amount:, balance_transaction:, id: REFUND_ID, transfer_reversal: nil, charge: CHARGE_ID)
    { id:, object: "refund", amount:, charge:, currency: "usd", status: "succeeded", balance_transaction:, transfer_reversal: }
  end

  def charge_json(amount: 100, refunded: 0, destination: nil, transfer: nil, application_fee: nil, balance_transaction: "txn_paritycharge01", livemode: false)
    { id: CHARGE_ID, object: "charge", amount:, amount_refunded: refunded, currency: "usd", livemode:, destination:, transfer:, transfer_group: nil,
      on_behalf_of: nil, application_fee:, balance_transaction: }.to_json
  end

  def respond(method, url, status: 200, body:)
    stub_request(method, url).to_return(status:, body: body.is_a?(String) ? body : body.to_json, headers: JSON_HEADERS)
  end

  def stub_charge_read(**options)
    respond(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\z}o, body: charge_json(**options))
  end

  def stub_refund_create(**options)
    respond(:post, "#{STRIPE_API}/refunds", body: refund_json(amount: 100, balance_transaction: "txn_parityrefund01", **options))
  end

  def stub_refund_read(amount: 100, destination_charge: nil, **options)
    refund = refund_json(amount:, balance_transaction: balance_transaction_json("txn_parityrefund01", -amount, net: -(amount - (amount * 0.3).floor), fee: -(amount * 0.3).floor), **options)
    respond(:get, %r{#{STRIPE_API}/refunds/#{REFUND_ID}\?.*expand}o, body: refund)
    respond(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\?.*expand}o, body: destination_charge || charge_json(refunded: amount, balance_transaction: balance_transaction_json("txn_paritycharge01", 100, net: 70, fee: 30)))
  end

  # A plain refund Stripe accepts and reports, for the sale's `amount` of the charge.
  def stub_successful_refund(amount: 100)
    stub_charge_read
    stub_refund_create
    stub_refund_read(amount:)
  end

  def stub_dropped_connection(method, url)
    stub_request(method, url).to_return do |request|
      Parity::Recorder.current&.record_dropped_http(request)
      raise Errno::ECONNRESET
    end
  end

  def expect_refused(message, purchase)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "message" => message)
    expect(purchase.reload.stripe_refunded).to be_falsey
    expect(Refund.count).to eq(0)
  end

  describe "when Stripe refuses the refund", parity: true do
    it "hands a refund to Rails when Stripe reports the charge as already refunded" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", status: 400, body: stripe_error("Charge #{CHARGE_ID} has already been refunded."))

      send_refund(sale)

      expect(response.parsed_body).to eq("success" => false, "message" => Purchase::Refundable::ALREADY_REFUNDED_ERROR_MESSAGE)
      expect(Refund.count).to eq(0)
    end

    it "hands a refund to Rails when Stripe answers insufficient balance" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", status: 400, body: stripe_error("Refund failed: insufficient funds in your Stripe balance.", code: "balance_insufficient"))

      send_refund(sale)

      expect(response.parsed_body).to eq("success" => false, "message" => Purchase::Refundable::INSUFFICIENT_FUNDS_GUMROAD_BALANCE_ERROR_MESSAGE)
      expect(Refund.count).to eq(0)
    end

    it "hands a refund to Rails when Stripe cannot find the charge" do
      respond(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\z}o, status: 404, body: stripe_error("No such charge: '#{CHARGE_ID}'", code: "resource_missing"))

      purchase = sale
      send_refund(purchase)

      expect_refused(Purchase::Refundable::PROCESSOR_REJECTED_REFUND_ERROR_MESSAGE, purchase)
    end

    it "hands a refund to Rails when Stripe rejects the refund request" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", status: 400, body: stripe_error("Refund amount is invalid."))

      purchase = sale
      send_refund(purchase)

      expect_refused(Purchase::Refundable::PROCESSOR_REJECTED_REFUND_ERROR_MESSAGE, purchase)
    end

    it "hands a refund to Rails when Stripe answers a server error" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end

    it "hands a refund to Rails when the connection drops on the refund request" do
      stub_charge_read
      stub_dropped_connection(:post, "#{STRIPE_API}/refunds")

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end

    it "hands a refund to Rails when the connection drops on the charge read" do
      stub_dropped_connection(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\z}o)

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end

    it "hands a refund to Rails when Stripe rate limits the refund request" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", status: 429, body: stripe_error("Too many requests", type: "rate_limit_error"))

      purchase = sale
      send_refund_unhandled(purchase)

      expect(response).to have_http_status(:internal_server_error)
      expect(Refund.count).to eq(0)
      expect(purchase.reload.stripe_refunded).to be_falsey
    end
  end

  describe "when the refund Stripe created cannot be read back", parity: true do
    it "hands a refund to Rails when Stripe fails to return the refund" do
      stub_charge_read
      stub_refund_create
      respond(:get, %r{#{STRIPE_API}/refunds/#{REFUND_ID}\?.*expand}o, status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end

    it "hands a refund to Rails when Stripe rate limits the refund read and the money has moved" do
      stub_charge_read
      stub_refund_create
      respond(:get, %r{#{STRIPE_API}/refunds/#{REFUND_ID}\?.*expand}o, status: 429, body: stripe_error("Too many requests", type: "rate_limit_error"))

      purchase = sale
      send_refund_unhandled(purchase)

      expect(response).to have_http_status(:internal_server_error)
      expect(Refund.count).to eq(0)
      expect(purchase.reload.stripe_refunded).to be_falsey
    end

    it "hands a refund to Rails when the connection drops on the refund read" do
      stub_charge_read
      stub_refund_create
      stub_dropped_connection(:get, %r{#{STRIPE_API}/refunds/#{REFUND_ID}\?.*expand}o)

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end

    it "hands a refund to Rails when Stripe fails to return the charge of the refund" do
      stub_charge_read
      stub_refund_create
      stub_refund_read
      respond(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\?.*expand}o, status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))

      purchase = sale
      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end
  end

  describe "when Stripe refunds a Stripe purchase", parity: true do
    it "hands a full refund to Rails and books the refund, the balance and the flags" do
      stub_successful_refund

      purchase = sale
      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => false)
      expect(purchase.reload).to have_attributes(stripe_refunded: true, stripe_partially_refunded: false)
      expect(Refund.sole).to have_attributes(amount_cents: 100, total_transaction_cents: 100, processor_refund_id: REFUND_ID, status: "succeeded")
    end

    it "hands a partial refund to Rails" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", body: refund_json(amount: 40, balance_transaction: "txn_parityrefund01"))
      stub_refund_read(amount: 40)

      purchase = sale
      send_refund(purchase, { amount: "0.40" })

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => true)
      expect(purchase.reload).to have_attributes(stripe_refunded: false, stripe_partially_refunded: true)
      expect(Refund.sole).to have_attributes(amount_cents: 40, total_transaction_cents: 40)
    end

    it "hands a refund of the rest of a partially refunded sale to Rails" do
      purchase = sale(stripe_partially_refunded: true)
      create(:refund, purchase:, amount_cents: 40, total_transaction_cents: 40, fee_cents: 12, creator_tax_cents: 0, gumroad_tax_cents: 0, processor_refund_id: "re_parityearlier01")
      stub_charge_read(refunded: 40)
      respond(:post, "#{STRIPE_API}/refunds", body: refund_json(amount: 60, balance_transaction: "txn_parityrefund01"))
      stub_refund_read(amount: 60)

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => false)
      expect(purchase.reload).to have_attributes(stripe_refunded: true, stripe_partially_refunded: false)
      expect(Refund.order(:id).last).to have_attributes(amount_cents: 60, total_transaction_cents: 60)
    end

    it "hands a refund for the whole price typed as an amount to Rails as a full refund" do
      stub_successful_refund

      purchase = sale
      send_refund(purchase, { amount: "1.00" })

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => false)
      expect(Refund.sole).to have_attributes(amount_cents: 100)
    end
  end

  describe "when the sale credited an affiliate", parity: true do
    let(:affiliate_user) { create(:affiliate_user) }
    let(:affiliate) { create(:direct_affiliate, seller:, affiliate_user:, affiliate_basis_points: 2000) }

    def affiliate_sale
      purchase = sale(affiliate:, affiliate_credit_cents: 14)
      create(:affiliate_credit, purchase:, affiliate:, affiliate_user:, seller:, link: product, amount_cents: 14, fee_cents: 2, basis_points: 2000)
      purchase
    end

    it "hands a full refund of an affiliate sale to Rails and reverses the affiliate's balance" do
      stub_successful_refund
      purchase = affiliate_sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
      expect(purchase.affiliate_credit.reload.affiliate_credit_refund_balance).to be_present
    end

    it "hands a partial refund of an affiliate sale to Rails and records the affiliate's partial refund" do
      stub_charge_read
      respond(:post, "#{STRIPE_API}/refunds", body: refund_json(amount: 40, balance_transaction: "txn_parityrefund01"))
      stub_refund_read(amount: 40)
      purchase = affiliate_sale

      send_refund(purchase, { amount: "0.40" })

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => true)
      expect(AffiliatePartialRefund.count).to eq(1)
    end
  end

  describe "a refund Rails refuses after reading the sale", parity: true do
    it "refuses an amount above the price" do
      purchase = sale
      send_refund(purchase, { amount: "5.00" })

      expect(response.parsed_body).to eq("success" => false, "message" => "Refund amount cannot be greater than the purchase price.")
      expect(purchase.reload.stripe_refunded).to be_falsey
    end

    it "hands a refund of a sale charged on a disconnected Stripe Connect account to Rails, which refuses it" do
      connect = create(:merchant_account_stripe_connect, user: seller)
      connect.mark_deleted!
      purchase = sale(merchant_account: connect)

      send_refund(purchase)

      expect(response.parsed_body).to eq("success" => false,
                                         "message" => "We cannot refund this sale because you have disconnected the associated payment account on Stripe. Please connect it and try again.")
    end
  end

  describe "when the sale was charged to a connected account", parity: true do
    let(:merchant_account) { create(:merchant_account, user: seller, charge_processor_merchant_id: DESTINATION_ACCOUNT) }

    def destination_charge(fee_refund: true)
      application_fee = { id: "fee_parity01", refunds: { object: "list", data: fee_refund ? [{ id: "fr_parity01", amount: 30, currency: "usd", balance_transaction: balance_transaction_json("txn_parityfee01", -30) }] : [] } }
      charge_json(destination: DESTINATION_ACCOUNT, transfer: TRANSFER_ID, application_fee: fee_refund ? application_fee : nil, balance_transaction: balance_transaction_json("txn_paritycharge01", 100, net: 70, fee: 30))
    end

    def destination_payment(fee_refund: true, refunded: 70)
      {
        id: DESTINATION_PAYMENT_ID, object: "charge", amount: 70, currency: "usd", balance_transaction: "txn_paritydestcharge01",
        refunds: { object: "list", data: [{ id: "pyr_parity01", amount: refunded, currency: "usd", balance_transaction: balance_transaction_json("txn_paritydestrefund01", -refunded) }] },
        application_fee: fee_refund ? { id: "fee_paritydest01", refunds: { object: "list", data: [{ id: "fr_paritydest01", amount: 30, currency: "usd" }] } } : nil
      }
    end

    def stub_destination_flow(fee_refund: true)
      stub_charge_read(destination: DESTINATION_ACCOUNT, transfer: TRANSFER_ID)
      stub_refund_create(transfer_reversal: "trr_parity01")
      stub_refund_read(destination_charge: destination_charge(fee_refund:))
      respond(:get, %r{#{STRIPE_API}/transfers/#{TRANSFER_ID}\z}o,
              body: { id: TRANSFER_ID, object: "transfer", destination: DESTINATION_ACCOUNT, destination_payment: DESTINATION_PAYMENT_ID, reversals: { object: "list", data: [{ id: "trr_parity01", destination_payment_refund: "pyr_parity01" }] } })
      respond(:get, %r{#{STRIPE_API}/charges/#{DESTINATION_PAYMENT_ID}}o, body: destination_payment(fee_refund:))
    end

    it "hands a refund of a destination charge to Rails and books the fee reversal" do
      stub_destination_flow
      purchase = sale(merchant_account:)

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
      expect(BalanceTransaction.where(refund: Refund.sole).count).to be >= 1
    end

    it "hands a refund of a destination charge with no fee refund to Rails" do
      stub_destination_flow(fee_refund: false)
      purchase = sale(merchant_account:)

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
    end

    it "hands a refund to Rails when Stripe fails to return the transfer of the destination charge" do
      stub_destination_flow
      respond(:get, %r{#{STRIPE_API}/transfers/#{TRANSFER_ID}\z}o, status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))
      purchase = sale(merchant_account:)

      send_refund(purchase)

      expect_refused("There is a temporary problem. Try to refund later.", purchase)
    end
  end

  describe "when the sale was charged on the seller's own Stripe account", parity: true do
    let(:merchant_account) { create(:merchant_account_stripe_connect, user: seller) }

    it "hands a refund through the seller's Stripe Connect account to Rails" do
      stub_successful_refund
      purchase = sale(merchant_account:)

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
    end

    it "hands a refund to Rails that falls back to Gumroad's Stripe account when the connected account refuses the read" do
      stub_successful_refund
      refused = { status: 403, body: stripe_error("The provided key does not have access to account.", type: "invalid_request_error"), headers: JSON_HEADERS }
      account_header = { headers: { "Stripe-Account" => merchant_account.charge_processor_merchant_id } }
      stub_request(:get, %r{#{STRIPE_API}/charges/#{CHARGE_ID}\z}o).with(account_header).to_return(refused)
      stub_request(:post, "#{STRIPE_API}/refunds").with(account_header).to_return(refused)
      stub_request(:get, %r{#{STRIPE_API}/refunds/#{REFUND_ID}\?.*expand}o).with(account_header).to_return(refused)
      purchase = sale(merchant_account:)

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
    end
  end
end
