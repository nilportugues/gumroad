# frozen_string_literal: true

require "spec_helper"

# POST /instant_payouts when Stripe answers the bank payout (or the internal transfer before it) with a failure, recorded for the
# Next.js port (PARITY_RECORD=1). Every branch after StripePayoutProcessor.perform_payment's `Stripe::Payout.create` writes
# differently: which failure reason the Payment gets, whether a bank account is deleted, whether the internal transfer is reversed,
# whether the seller's payouts are held. `parity_timeline` records those writes against the Stripe calls, so a port can be held to
# the same order. Stripe is WebMock only: the account setup replays the cassette InstantPayoutsService's own spec recorded, and the
# failing answers are stubbed over it. A dropped connection is recorded as a call with `response.dropped`.
describe "Instant payout failures", type: :request, parity_timeline: true do
  include Parity::AudienceSignedIn

  INSTANT_PAYOUT_FAILURES_CASSETTE = Rails.root.join(
    "spec/support/fixtures/vcr_cassettes/InstantPayoutsService/_perform/with_stripe_account/" \
    "when_seller_has_a_balance_within_the_instant_payout_range/creates_and_processes_an_instant_payout.yml"
  )
  STRIPE_API = "https://api.stripe.com/v1"
  JSON_HEADERS = { "Content-Type" => "application/json" }.freeze
  INTERNAL_TRANSFER_ID = "tr_parityinternal01"
  DESTINATION_PAYMENT_ID = "py_parityinternal01"
  REVERSAL_REFUND_TRANSACTION_ID = "txn_parityrefund01"

  let(:seller) { create(:compliant_user, name: "Instant Seller", username: "instantseller") }
  let(:stripe_account_id) { MerchantAccount.where(user: seller).last.charge_processor_merchant_id }

  before do
    host! DOMAIN
    # The suite retries a 429 up to twelve times (spec/support/stripe_rate_limit_retries.rb); the gem does not, and that is what a port sees.
    allow(Stripe::StripeClient).to receive(:should_retry?).and_wrap_original do |original, error, **options|
      error.is_a?(Stripe::RateLimitError) ? false : original.call(error, **options)
    end
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
  end

  # Mail deliveries are ActiveJobs, which the test adapter swallows; the recorder sees them on the Sidekiq adapter.
  around do |example|
    previous = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :sidekiq
    example.run
  ensure
    ActiveJob::Base.queue_adapter = previous
  end

  def stub_stripe_from_cassette(path)
    interactions = YAML.safe_load_file(path, permitted_classes: [Symbol])["http_interactions"]
    interactions.group_by { |interaction| [interaction["request"]["method"].to_sym, interaction["request"]["uri"]] }.each do |(method, uri), group|
      stub_request(method, uri).to_return(
        group.map do |interaction|
          response = interaction["response"]
          { status: response["status"]["code"], body: response["body"]["string"], headers: { "Content-Type" => response["headers"]["Content-Type"].first } }
        end
      )
    end
  end

  # The seller of instant_payouts_parity_spec.rb with a $1,000 balance held by Stripe or, for the internal-transfer branches, by Gumroad.
  def prepare_seller(held_by:)
    stub_stripe_from_cassette(INSTANT_PAYOUT_FAILURES_CASSETTE)
    create(:tos_agreement, user: seller)
    create(:user_compliance_info, user: seller)
    create_list(:payment_completed, 4, user: seller)
    create(:ach_account_stripe_succeed, user: seller)
    merchant_account = StripeMerchantAccountManager.create_account(seller.reload, passphrase: "1234")
    merchant_account.update!(created_at: 90.days.ago)
    stripe_account = Stripe::Account.retrieve(merchant_account.charge_processor_merchant_id)
    stripe_account.refresh until stripe_account.payouts_enabled?
    stub_request(:get, "#{STRIPE_API}/balance").to_return(
      status: 200, headers: JSON_HEADERS,
      body: { object: "balance", available: [{ amount: 1_000_000_00, currency: "usd" }], pending: [{ amount: 0, currency: "usd" }] }.to_json
    )
    Stripe::Transfer.create(destination: stripe_account.id, currency: "usd", amount: 1000_00)
    holder = held_by == :gumroad ? MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id) : merchant_account
    create(:balance, amount_cents: 1000_00, holding_amount_cents: 1000_00, user: seller, date: Date.yesterday, merchant_account: holder)
    log_in(seller)
  end

  def stripe_error(message, type: "invalid_request_error", code: nil)
    { error: { message:, type:, code: }.compact }.to_json
  end

  def stub_payout_failure(status, body)
    stub_request(:post, "#{STRIPE_API}/payouts").to_return(status:, body:, headers: JSON_HEADERS)
  end

  # Every attempt is recorded: the Stripe gem retries a dropped connection (Stripe.max_network_retries) under one idempotency key.
  def stub_dropped_connection(method, url)
    stub_request(method, url).to_return do |request|
      Parity::Recorder.current&.record_dropped_http(request)
      raise Errno::ECONNRESET
    end
  end

  def transfer_json
    {
      id: INTERNAL_TRANSFER_ID, object: "transfer", amount: 1000_00, amount_reversed: 0, currency: "usd",
      destination: stripe_account_id, destination_payment: DESTINATION_PAYMENT_ID,
      balance_transaction: { id: "txn_parityinternal01", object: "balance_transaction", amount: -1000_00, net: -1000_00, currency: "usd" },
      reversals: { object: "list", data: [], has_more: false, url: "/v1/transfers/#{INTERNAL_TRANSFER_ID}/reversals" }
    }.to_json
  end

  def destination_charge_json(refunded: false)
    {
      id: DESTINATION_PAYMENT_ID, object: "charge", amount: 1000_00, currency: "usd",
      balance_transaction: { id: "txn_paritydestination01", object: "balance_transaction", amount: 1000_00, net: 1000_00, currency: "usd" },
      refunds: { object: "list", has_more: false, data: refunded ? [{ id: "re_parity01", object: "refund", balance_transaction: REVERSAL_REFUND_TRANSACTION_ID }] : [] }
    }.to_json
  end

  def stub_internal_transfer
    stub_request(:post, "#{STRIPE_API}/transfers").to_return(status: 200, body: transfer_json, headers: JSON_HEADERS)
    stub_request(:get, %r{#{STRIPE_API}/charges/#{DESTINATION_PAYMENT_ID}}o).to_return(status: 200, body: destination_charge_json, headers: JSON_HEADERS)
  end

  # The reversal of the internal transfer after the payout failed: the transfer, its reversal, the destination charge with the
  # refund the reversal made, and that refund's balance transaction. A `refund_net` short of the transfer is the FX residual a credit covers.
  def stub_internal_transfer_reversal(refund_net: -1000_00)
    stub_request(:get, "#{STRIPE_API}/transfers/#{INTERNAL_TRANSFER_ID}").to_return(status: 200, body: transfer_json, headers: JSON_HEADERS)
    stub_request(:post, "#{STRIPE_API}/transfers/#{INTERNAL_TRANSFER_ID}/reversals").to_return(
      status: 200, body: { id: "trr_parity01", object: "transfer_reversal", amount: 1000_00, transfer: INTERNAL_TRANSFER_ID }.to_json, headers: JSON_HEADERS
    )
    stub_request(:get, %r{#{STRIPE_API}/charges/#{DESTINATION_PAYMENT_ID}\?.*refunds}o).to_return(status: 200, body: destination_charge_json(refunded: true), headers: JSON_HEADERS)
    stub_request(:get, %r{#{STRIPE_API}/balance_transactions/#{REVERSAL_REFUND_TRANSACTION_ID}}o).to_return(
      status: 200, body: { id: REVERSAL_REFUND_TRANSACTION_ID, object: "balance_transaction", amount: refund_net, net: refund_net, currency: "usd" }.to_json, headers: JSON_HEADERS
    )
  end

  def post_instant_payout
    post instant_payouts_path, params: { date: Date.today.to_s }.to_json,
                               headers: { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "X-Inertia" => "true", "X-CSRF-Token" => csrf_token }
  end

  def payment
    Payment.where(user: seller).order(:id).last
  end

  def expect_failed_payout(reason)
    expect(response).to redirect_to(balance_path)
    expect(flash[:alert]).to eq("Failed to process instant payout")
    expect(payment).to have_attributes(state: "failed", failure_reason: reason, payout_type: Payouts::PAYOUT_TYPE_INSTANT)
    expect(payment.balances.map(&:state).uniq).to eq(["unpaid"])
  end

  describe "when Stripe refuses the bank payout", parity: true do
    {
      "an account without the funds" => [400, ->(t) { t.stripe_error("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient") }, Payment::FailureReason::INSUFFICIENT_FUNDS],
      "an account that cannot be paid" => [400, ->(t) { t.stripe_error("Cannot create payouts; your account has outstanding requirements.") }, Payment::FailureReason::CANNOT_PAY],
      "a debit card over the limit" => [400, ->(t) { t.stripe_error("Debit card transfers are only supported for amounts less than $3,000.00.") }, Payment::FailureReason::DEBIT_CARD_LIMIT],
      "an amount under the Stripe minimum" => [400, ->(t) { t.stripe_error("Amount must be no less than $0.50") }, Payment::FailureReason::BELOW_STRIPE_PAYOUT_MINIMUM],
      "an account that requires intervention" => [400, ->(t) { t.stripe_error("This account requires further intervention before it can be paid out.") }, Payment::FailureReason::STRIPE_INTERVENTION_REQUIRED],
      "a destination in another currency" => [400, ->(t) { t.stripe_error("Attempting to create a transfer of usd to a destination that supports eur.") }, Payment::FailureReason::DESTINATION_CURRENCY_MISMATCH],
      "a bank account Stripe cannot find" => [400, ->(t) { t.stripe_error("No such external account: 'ba_parity'") }, Payment::FailureReason::BANK_ACCOUNT_NOT_FOUND_AT_STRIPE],
      "a rate limit" => [429, ->(t) { t.stripe_error("Too many requests", type: "rate_limit_error") }, Payment::FailureReason::PROCESSOR_RATE_LIMITED],
    }.each do |label, (status, body, reason)|
      it "serves an instant payout when Stripe answers #{label}" do
        prepare_seller(held_by: :stripe)
        stub_payout_failure(status, body.call(self))

        post_instant_payout

        expect_failed_payout(reason)
        deleted_bank_accounts = BankAccount.where(user: seller).where.not(deleted_at: nil).count
        expect(deleted_bank_accounts).to eq(reason == Payment::FailureReason::BANK_ACCOUNT_NOT_FOUND_AT_STRIPE ? 1 : 0)
      end
    end

    it "serves an instant payout when Stripe answers an error no reason covers" do
      prepare_seller(held_by: :stripe)
      stub_payout_failure(400, stripe_error("Something nobody wrote a reason for."))

      post_instant_payout

      expect_failed_payout(nil)
    end

    it "serves an instant payout when Stripe fails with a server error" do
      prepare_seller(held_by: :stripe)
      stub_payout_failure(500, stripe_error("An error occurred on our side.", type: "api_error"))

      post_instant_payout

      expect_failed_payout(nil)
    end

    it "serves an instant payout when the connection drops after the payout was sent" do
      prepare_seller(held_by: :stripe)
      stub_dropped_connection(:post, "#{STRIPE_API}/payouts")

      post_instant_payout

      expect_failed_payout(Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
      expect(seller.reload.payouts_paused_internally?).to be(true)
    end
  end

  describe "when the funds are held by Gumroad", parity: true do
    it "serves an instant payout when the bank payout fails and the internal transfer is reversed" do
      prepare_seller(held_by: :gumroad)
      stub_internal_transfer
      stub_internal_transfer_reversal
      stub_payout_failure(400, stripe_error("Cannot create payouts; your account has outstanding requirements."))

      post_instant_payout

      expect_failed_payout(Payment::FailureReason::CANNOT_PAY)
      expect(payment.stripe_internal_transfer_id).to eq(INTERNAL_TRANSFER_ID)
    end

    it "serves an instant payout when the reversal leaves a currency difference to credit" do
      prepare_seller(held_by: :gumroad)
      stub_internal_transfer
      stub_internal_transfer_reversal(refund_net: -999_00)
      stub_payout_failure(400, stripe_error("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient"))

      post_instant_payout

      expect_failed_payout(Payment::FailureReason::INSUFFICIENT_FUNDS)
      expect(payment.credit).to be_present
    end

    it "serves an instant payout when the connection drops after the payout and the transfer is reversed and held" do
      prepare_seller(held_by: :gumroad)
      stub_internal_transfer
      stub_internal_transfer_reversal
      stub_dropped_connection(:post, "#{STRIPE_API}/payouts")

      post_instant_payout

      expect_failed_payout(Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
      expect(seller.reload.payouts_paused_internally?).to be(true)
    end

    it "serves an instant payout when the reversal itself fails and the seller is held" do
      prepare_seller(held_by: :gumroad)
      stub_internal_transfer
      stub_request(:get, "#{STRIPE_API}/transfers/#{INTERNAL_TRANSFER_ID}").to_return(status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"), headers: JSON_HEADERS)
      stub_payout_failure(429, stripe_error("Too many requests", type: "rate_limit_error"))

      post_instant_payout

      expect(payment).to have_attributes(state: "failed", failure_reason: Payment::FailureReason::UNREVERSED_INTERNAL_TRANSFER)
      expect(seller.reload.payouts_paused_internally?).to be(true)
    end

    it "serves an instant payout when the internal transfer is refused" do
      prepare_seller(held_by: :gumroad)
      stub_request(:post, "#{STRIPE_API}/transfers").to_return(status: 400, body: stripe_error("You have insufficient funds in your Stripe account for this transfer.", code: "balance_insufficient"), headers: JSON_HEADERS)

      post_instant_payout

      expect(response).to redirect_to(balance_path)
      expect(payment).to have_attributes(state: "failed", failure_reason: Payment::FailureReason::INSUFFICIENT_FUNDS)
    end

    it "serves an instant payout when the connection drops on the internal transfer" do
      prepare_seller(held_by: :gumroad)
      stub_dropped_connection(:post, "#{STRIPE_API}/transfers")

      post_instant_payout

      expect(payment).to have_attributes(state: "failed", failure_reason: Payment::FailureReason::PAYOUT_OUTCOME_UNKNOWN)
      expect(seller.reload.payouts_paused_internally?).to be(true)
    end
  end
end
