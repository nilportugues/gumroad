# frozen_string_literal: true

require "spec_helper"

# The Stripe calls Rails makes after the refund ledger is committed, recorded for the Next.js port (PARITY_RECORD=1). A refund of a
# sale charged on a Gumroad-managed Stripe account retains the processor fee: `Credit.create_for_refund_fee_retention!` books the
# debit inside the transaction, and `Refund#recover_pending_fee_retention!` collects it from the seller's Stripe account once the
# outermost transaction commits (a grouped transfer for a US account, a transfer reversal for any other). None of it shows in the
# answer to the request: `parity_timeline` pins the writes against the calls, and the refund row (retention state, error, attempts)
# is the visible result. Stripe is WebMock only; every answer is built here and nothing leaves the machine.
describe "Refund fee retention after the ledger", type: :request, parity_timeline: true do
  include Parity::AudienceSignedIn

  let(:api) { "https://api.stripe.com/v1" }
  let(:json_headers) { { "Content-Type" => "application/json" } }
  let(:charge_id) { "ch_parityretain01" }
  let(:refund_id) { "re_parityretain01" }
  let(:transfer_id) { "tr_parityretain01" }
  let(:account_id) { "acct_parityretain01" }
  let(:payment_id) { "py_parityretain01" }
  let(:account_header) { { headers: { "Stripe-Account" => account_id } } }
  let(:country) { "CA" }
  let(:seller) { create(:user, name: "Retain Seller", username: "retainseller", unpaid_balance_cents: 2000, created_at: Time.utc(2025, 1, 1)) }
  let(:product) { create(:product, user: seller, name: "Retained product", unique_permalink: "retained", created_at: Time.utc(2025, 1, 1)) }
  let(:merchant_account) do
    create(:merchant_account, user: seller, charge_processor_merchant_id: account_id, country:, currency: country == "US" ? "usd" : "cad")
  end
  let(:request_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/customers" }
  end

  before do
    host! DOMAIN
    # The suite retries a 429 up to twelve times (spec/support/stripe_rate_limit_retries.rb); the gem does not, and that is what a port sees.
    allow(Stripe::StripeClient).to receive(:should_retry?).and_wrap_original do |original, error, **options|
      error.is_a?(Stripe::RateLimitError) ? false : original.call(error, **options)
    end
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
    # The Canadian account holds CAD; the rate is what turns the retained USD cents into the amount of a reversal.
    Redis::Namespace.new(:currencies, redis: $redis).set("CAD", "1.25")
  end

  def sale(**attributes)
    build(:purchase, link: product, seller:, email: "buyer@example.com", price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100, tax_cents: 0,
                     purchase_state: "successful", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:,
                     stripe_transaction_id: charge_id, **attributes).tap { _1.save!(validate: false) }.tap { _1.update_columns(price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100, **attributes) }
  end

  def send_refund(purchase, body = {})
    log_in(seller)
    put "/purchases/#{purchase.external_id}/refund", params: body.to_json, headers: request_headers.merge("X-CSRF-Token" => csrf_token)
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
    { error: { message:, type:, code: }.compact }
  end

  def balance_transaction_json(id, amount, net: amount, fee: 0, currency: "usd")
    { id:, object: "balance_transaction", amount:, net:, fee:, currency: }
  end

  def respond(method, url, status: 200, body:, with: nil)
    stub = stub_request(method, url)
    stub = stub.with(with) if with
    stub.to_return(status:, body: body.is_a?(String) ? body : body.to_json, headers: json_headers)
  end

  def stripe_list(*data) = { object: "list", data:, has_more: false }

  # A destination charge refunded in full: the sale is 1000 cents, the seller's account was sent 700, and Stripe refunds all of it.
  def stub_destination_refund(amount: 1000, charge_amount: 1000, seller_leg: 700)
    application_fee = { id: "fee_parityretain01", refunds: stripe_list({ id: "fr_parityretain01", amount: amount * 3 / 10, currency: "usd", balance_transaction: balance_transaction_json("txn_parityfee01", -(amount * 3 / 10)) }) }
    respond(:get, %r{#{api}/charges/#{charge_id}\z}o,
            body: { id: charge_id, object: "charge", amount: charge_amount, amount_refunded: 0, currency: "usd", livemode: false, destination: account_id, transfer: transfer_id,
                    transfer_group: nil, on_behalf_of: nil, application_fee: nil, balance_transaction: "txn_parityretaincharge01" })
    respond(:post, "#{api}/refunds",
            body: { id: refund_id, object: "refund", amount:, charge: charge_id, currency: "usd", status: "succeeded", balance_transaction: "txn_parityretainrefund01", transfer_reversal: "trr_parityretain01" })
    respond(:get, %r{#{api}/refunds/#{refund_id}\?.*expand}o,
            body: { id: refund_id, object: "refund", amount:, charge: charge_id, currency: "usd", status: "succeeded", transfer_reversal: "trr_parityretain01",
                    balance_transaction: balance_transaction_json("txn_parityretainrefund01", -amount, net: -(amount - amount * 3 / 10), fee: -(amount * 3 / 10)) })
    respond(:get, %r{#{api}/charges/#{charge_id}\?.*expand}o,
            body: { id: charge_id, object: "charge", amount: charge_amount, amount_refunded: amount, currency: "usd", livemode: false, destination: account_id, transfer: transfer_id,
                    transfer_group: nil, on_behalf_of: nil, application_fee:, balance_transaction: balance_transaction_json("txn_parityretaincharge01", charge_amount, net: seller_leg, fee: charge_amount - seller_leg) })
    respond(:get, %r{#{api}/transfers/#{transfer_id}\z}o,
            body: { id: transfer_id, object: "transfer", destination: account_id, destination_payment: payment_id, amount: seller_leg, amount_reversed: 0, currency: "usd",
                    reversals: stripe_list({ id: "trr_parityretain01", amount: amount * 7 / 10, currency: "usd", source_refund: refund_id, destination_payment_refund: "pyr_parityretain01" }) })
    respond(:get, %r{#{api}/charges/#{payment_id}}o,
            body: { id: payment_id, object: "charge", amount: seller_leg, currency: "usd", balance_transaction: "txn_parityretaindest01",
                    refunds: stripe_list({ id: "pyr_parityretain01", amount: amount * 7 / 10, currency: "usd", balance_transaction: balance_transaction_json("txn_parityretaindestrefund01", -(amount * 7 / 10)) }),
                    application_fee: { id: "fee_parityretaindest01", refunds: stripe_list({ id: "fr_parityretaindest01", amount: amount * 3 / 10, currency: "usd" }) } })
  end

  def transfer_json(id, amount: 5000, amount_reversed: 0, currency: "usd")
    { id:, object: "transfer", destination: account_id, amount:, amount_reversed:, currency:, reversals: stripe_list }
  end

  # Where Stripe booked the reversal on the seller's account: what the collection records as the cents actually taken.
  def stub_reversal_settlement(net: -3000)
    respond(:get, %r{#{api}/refunds/pyr_paritycollect01}o, with: account_header,
            body: { id: "pyr_paritycollect01", object: "refund", amount: 3000, currency: "cad", balance_transaction: "txn_paritycollect01" })
    respond(:get, %r{#{api}/balance_transactions/txn_paritycollect01}o, with: account_header,
            body: balance_transaction_json("txn_paritycollect01", net, currency: "cad"))
  end

  def reversal_json(id = "trr_paritycollect01")
    { id:, object: "transfer_reversal", amount: 4125, currency: "cad", destination_payment_refund: "pyr_paritycollect01", metadata: { refund_id: Refund.last&.id.to_s } }
  end

  describe "a Gumroad-managed account outside the US", parity: true do
    def stub_transfer_list(*transfers)
      respond(:get, %r{#{api}/transfers\?.*destination=#{account_id}}o, body: stripe_list(*transfers))
    end

    it "hands a refund to Rails that collects the retained fee by reversing a transfer to the account" do
      stub_destination_refund
      stub_transfer_list(transfer_json("tr_paritypayout01"))
      respond(:post, "#{api}/transfers/tr_paritypayout01/reversals", body: reversal_json)
      stub_reversal_settlement
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => false, "retained_fee_cents" => 59, "fee_retention_source_transfer" => "tr_paritypayout01",
                                             "debited_stripe_transfer" => "trr_paritycollect01", "fee_retention_collected_cents" => 3000)
    end

    it "hands a refund to Rails that moves on to a second transfer when Stripe has nothing left to reverse on the first" do
      stub_destination_refund
      # The lookup runs again after the refusal, and by then Stripe reports the first transfer as spent.
      stub_request(:get, %r{#{api}/transfers\?.*destination=#{account_id}}o)
        .to_return({ status: 200, headers: json_headers, body: stripe_list(transfer_json("tr_paritypayout01"), transfer_json("tr_paritypayout02")).to_json },
                   { status: 200, headers: json_headers, body: stripe_list(transfer_json("tr_paritypayout01", amount_reversed: 5000), transfer_json("tr_paritypayout02")).to_json })
      respond(:post, "#{api}/transfers/tr_paritypayout01/reversals", status: 400,
                                                                     body: stripe_error("Cannot create a reversal for more than the amount remaining to reverse (0).", code: "invalid_request"))
      respond(:get, %r{#{api}/transfers/tr_paritypayout01/reversals}o, body: stripe_list)
      respond(:post, "#{api}/transfers/tr_paritypayout02/reversals", body: reversal_json)
      stub_reversal_settlement
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => false, "fee_retention_source_transfer" => "tr_paritypayout02", "debited_stripe_transfer" => "trr_paritycollect01")
    end

    it "hands a refund to Rails that writes the fee off when the account has no transfer to reverse" do
      stub_destination_refund
      stub_transfer_list
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => false, "fee_retention_written_off_cents" => 59, "fee_retention_write_off_reason" => "no_reversible_transfer")
    end

    it "hands a refund to Rails that keeps the fee pending when Stripe fails the reversal" do
      stub_destination_refund
      stub_transfer_list(transfer_json("tr_paritypayout01"))
      respond(:post, "#{api}/transfers/tr_paritypayout01/reversals", status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => true, "fee_retention_attempts" => 1)
    end

    it "hands a refund to Rails that keeps the fee pending when the connection drops while listing the transfers" do
      stub_destination_refund
      stub_request(:get, %r{#{api}/transfers\?.*destination=#{account_id}}o).to_return do |request|
        Parity::Recorder.current&.record_dropped_http(request)
        raise Errno::ECONNRESET
      end
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => true, "fee_retention_attempts" => 1)
    end
  end

  describe "a Gumroad-managed account in the US", parity: true do
    let(:country) { "US" }

    # spec/support/refund_fee_retention_transfer_stubs.rb answers the grouped debit itself; the port has to make the calls.
    before do
      allow(Stripe::Transfer).to receive(:list).and_call_original
      allow(Stripe::Transfer).to receive(:create).and_call_original
    end

    it "hands a refund to Rails that collects the retained fee with a transfer from the seller's account to Gumroad" do
      stub_destination_refund
      respond(:get, %r{#{api}/transfers\?.*transfer_group=refund_fee_retention_}o, with: account_header, body: stripe_list)
      respond(:post, "#{api}/transfers", with: account_header,
                                         body: { id: "tr_parityfee01", object: "transfer", amount: 59, currency: "usd", destination: "acct_gumroadplatform" })
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => false, "debited_stripe_transfer" => "tr_parityfee01", "fee_retention_collected_cents" => 59)
    end

    it "hands a refund to Rails that adopts a fee transfer Stripe already made for the refund" do
      stub_destination_refund
      respond(:get, %r{#{api}/transfers\?.*transfer_group=refund_fee_retention_}o, with: account_header,
                                                                                  body: stripe_list({ id: "tr_parityfee00", object: "transfer", amount: 59, currency: "usd" }))
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => false, "debited_stripe_transfer" => "tr_parityfee00", "fee_retention_collected_cents" => 59)
    end

    it "hands a refund to Rails that keeps the fee pending when Stripe refuses the transfer" do
      stub_destination_refund
      respond(:get, %r{#{api}/transfers\?.*transfer_group=refund_fee_retention_}o, with: account_header, body: stripe_list)
      respond(:post, "#{api}/transfers", with: account_header, status: 400, body: stripe_error("Insufficient funds in Stripe account.", code: "balance_insufficient"))
      purchase = sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.sole.json_data).to include("fee_retention_pending" => true, "fee_retention_attempts" => 1)
    end
  end

  describe "a refund that books the rest of a sale whose VAT was refunded earlier", parity: true do
    before { stub_const("GUMROAD_ADMIN_ID", create(:admin_user).id) }

    def vat_refunded_sale
      sale(gumroad_tax_cents: 100, total_transaction_cents: 1100, stripe_partially_refunded: true).tap do |purchase|
        create(:refund, purchase:, amount_cents: 0, total_transaction_cents: 100, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 100, processor_refund_id: "re_parityearlier01")
      end
    end

    it "hands a refund to Rails that reverses the excess from the transfer to the seller's account" do
      stub_destination_refund(amount: 400, charge_amount: 1100, seller_leg: 770)
      respond(:post, "#{api}/transfers/#{transfer_id}/reversals", body: { id: "trr_parityexcess01", object: "transfer_reversal", amount: 280, currency: "usd", destination_payment_refund: "pyr_parityexcess01" })
      respond(:get, %r{#{api}/refunds/pyr_parityexcess01}o, with: account_header, body: { id: "pyr_parityexcess01", object: "refund", amount: 280, currency: "cad", balance_transaction: "txn_parityexcess01" })
      respond(:get, %r{#{api}/balance_transactions/txn_parityexcess01}o, with: account_header, body: balance_transaction_json("txn_parityexcess01", -350, currency: "cad"))
      purchase = vat_refunded_sale

      send_refund(purchase, { amount: "4.00" })

      expect(response.parsed_body).to include("success" => true, "partially_refunded" => true)
      expect(Credit.where(crediting_user_id: GUMROAD_ADMIN_ID).count).to eq(1)
    end

    it "hands a refund to Rails that books the refund when Stripe says the transfer was already fully reversed" do
      stub_destination_refund(amount: 400, charge_amount: 1100, seller_leg: 770)
      respond(:post, "#{api}/transfers/#{transfer_id}/reversals", status: 400, body: stripe_error("Transfer tr_parityretain01 is already fully reversed.", code: "invalid_request"))
      purchase = vat_refunded_sale

      send_refund(purchase, { amount: "4.00" })

      expect(response.parsed_body).to include("success" => true)
      expect(Refund.where(processor_refund_id: refund_id).count).to eq(1)
      expect(Credit.where(crediting_user_id: GUMROAD_ADMIN_ID).count).to eq(0)
    end
  end

  describe "a refund whose excess reversal Stripe fails", parity: true do
    before { stub_const("GUMROAD_ADMIN_ID", create(:admin_user).id) }

    it "hands a refund to Rails that answers 500 and books nothing when Stripe fails the reversal after refunding" do
      stub_destination_refund(amount: 400, charge_amount: 1100, seller_leg: 770)
      respond(:post, "#{api}/transfers/#{transfer_id}/reversals", status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))
      purchase = sale(gumroad_tax_cents: 100, total_transaction_cents: 1100, stripe_partially_refunded: true)
      create(:refund, purchase:, amount_cents: 0, total_transaction_cents: 100, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 100, processor_refund_id: "re_parityearlier01")

      send_refund_unhandled(purchase, { amount: "4.00" })

      expect(response).to have_http_status(:internal_server_error)
      expect(Refund.where(processor_refund_id: refund_id).count).to eq(0)
    end
  end

  describe "a refund of a sale whose dispute Gumroad won", parity: true do
    def won_sale
      sale(chargeback_date: Time.utc(2026, 10, 1)).tap do |purchase|
        purchase.update_attribute(:chargeback_reversed, true)
        create(:dispute, purchase:, charge_processor_dispute_id: "dp_parityretain01").tap { _1.update_columns(state: "won", won_at: Time.utc(2026, 10, 20)) }
      end
    end

    it "hands a refund to Rails that reverses the transfer Stripe made when the dispute was won" do
      stub_destination_refund
      respond(:get, %r{#{api}/transfers\?.*destination=#{account_id}}o,
              body: stripe_list(transfer_json("tr_paritywon01", amount: 700).merge(description: "Dispute dp_parityretain01 won")))
      # The same transfer is reversed twice: the dispute's 700 first, then the retained fee once the refund commits.
      respond(:post, "#{api}/transfers/tr_paritywon01/reversals", body: reversal_json("trr_paritywon01"))
      stub_reversal_settlement
      purchase = won_sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
    end

    it "hands a refund to Rails that books the refund when the dispute transfer is not on the account" do
      stub_destination_refund
      respond(:get, %r{#{api}/transfers\?.*destination=#{account_id}}o, body: stripe_list(transfer_json("tr_paritywon01", amount: 700).merge(description: "Payout")))
      respond(:post, "#{api}/transfers/tr_paritywon01/reversals", body: reversal_json("trr_paritywon01"))
      stub_reversal_settlement
      purchase = won_sale

      send_refund(purchase)

      expect(response.parsed_body).to include("success" => true)
      expect(purchase.reload.stripe_refunded).to be(true)
    end
  end
end
