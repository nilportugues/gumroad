# frozen_string_literal: true

require "spec_helper"

# The settings payments save that makes Rails create a Stripe account (StripeMerchantAccountManager.create_account), when Stripe
# does not simply answer the creation with the account. settings_payments_stripe_account_parity_spec.rb records the success; here
# every answer to `POST /v1/accounts` is stubbed over that cassette, so a port can be held to what Rails
# writes for each: the pending-creation note and its idempotency key, the no-verdict or rejection note, the merchant account row
# that is created and soft-deleted, and the retry job. `parity_timeline` records those
# writes against the Stripe calls. A dropped connection is recorded as a call with `response.dropped`; the Stripe gem retries it
# (and a 5xx) up to four times under one idempotency key, and does not retry a 429. Stripe is WebMock only.
#
# Node does not port the creation, so every example is a hand-back: the replay asserts the request reaches Rails whole with no
# Stripe call and no write from Node.
describe "Settings::PaymentsController Stripe account creation failures", type: :request, parity_timeline: true do
  include Parity::AudienceSignedIn

  ACCOUNT_CREATION_FAILURES_CASSETTE = Rails.root.join(
    "spec/support/fixtures/vcr_cassettes/StripeMerchantAccountManager/_create_account/all_info_provided_of_an_individual/" \
    "creates_an_account_at_stripe_with_all_the_params.yml"
  )
  STRIPE_ACCOUNTS_URL = "https://api.stripe.com/v1/accounts"
  JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Account Seller", username: "accountseller", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings/payments" }
  end
  let(:cassette_interactions) { YAML.safe_load_file(ACCOUNT_CREATION_FAILURES_CASSETTE, permitted_classes: [Symbol])["http_interactions"] }
  let(:created_account) { cassette_interactions.find { _1["request"]["method"] == "post" }["response"]["body"]["string"] }
  let(:created_account_id) { JSON.parse(created_account)["id"] }

  before do
    host! DOMAIN
    # The suite retries a 429 up to twelve times (spec/support/stripe_rate_limit_retries.rb); the gem does not, and that is what a port sees.
    allow(Stripe::StripeClient).to receive(:should_retry?).and_wrap_original do |original, error, **options|
      error.is_a?(Stripe::RateLimitError) ? false : original.call(error, **options)
    end
    create(:user_compliance_info, user: seller)
    create(:ach_account_stripe_succeed, user: seller)
    log_in(seller)
  end

  def stripe_error(message, type: "invalid_request_error", code: nil, param: nil)
    { error: { message:, type:, code:, param: }.compact }.to_json
  end

  # Every attempt of the creation lands here with the key it carried.
  let(:creation_keys) { [] }

  def stub_account_creation(status:, body:)
    stub_request(:post, STRIPE_ACCOUNTS_URL).to_return do |request|
      creation_keys << request.headers["Idempotency-Key"]
      { status:, body:, headers: JSON_HEADERS }
    end
  end

  def drop_connection(request)
    creation_keys << request.headers["Idempotency-Key"]
    Parity::Recorder.current&.record_dropped_http(request)
    raise Errno::ECONNRESET
  end

  def save_payments
    put settings_payments_path, params: { payout_frequency: "monthly" }.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def creation_requests = a_request(:post, STRIPE_ACCOUNTS_URL)

  def payout_notes = seller.reload.comments.where(comment_type: Comment::COMMENT_TYPE_PAYOUT_NOTE).order(:id)

  describe "when Stripe refuses the creation", parity: true do
    it "hands a save to Rails when Stripe rejects the account details" do
      stub_account_creation(status: 400, body: stripe_error("The country specified is not supported.", param: "country"))

      save_payments

      expect(creation_requests).to have_been_made.once
      expect(seller.reload.stripe_account).to be_blank
      expect(MerchantAccount.where(user: seller, charge_processor_id: StripeChargeProcessor.charge_processor_id).count).to eq(1)
      expect(MerchantAccount.where(user: seller).first.deleted_at).to be_present
    end

    it "hands a save to Rails when Stripe rejects the postal code" do
      stub_account_creation(status: 400, body: stripe_error("Invalid postal code.", param: "individual[address][postal_code]"))

      save_payments

      expect(creation_requests).to have_been_made.once
      expect(payout_notes.map(&:content).join).to include(StripeMerchantAccountManager::ACCOUNT_REJECTION_NOTE_PREFIX)
    end

    it "hands a save to Rails when Stripe answers a rate limit, which the gem does not retry" do
      stub_account_creation(status: 429, body: stripe_error("Too many requests", type: "rate_limit_error"))

      save_payments

      expect(creation_requests).to have_been_made.once
      expect(payout_notes.map(&:content).join).to include(StripeMerchantAccountManager::NO_VERDICT_FAILURE_NOTE_PREFIX)
      expect(RetryStripeRejectedPayoutSetupForSellerJob.jobs.size).to eq(1)
    end
  end

  describe "when Stripe gives no verdict", parity: true do
    it "hands a save to Rails when Stripe fails with a server error, tried four times under one idempotency key" do
      stub_account_creation(status: 500, body: stripe_error("An error occurred on our side.", type: "api_error"))

      save_payments

      expect(creation_requests).to have_been_made.times(4)
      expect(creation_keys.uniq.size).to eq(1)
      expect(creation_keys.first).to be_present
      expect(payout_notes.last.json_data[StripeMerchantAccountManager::ACCOUNT_CREATION_IDEMPOTENCY_KEY]).to eq(creation_keys.first)
      expect(RetryStripeRejectedPayoutSetupForSellerJob.jobs.size).to eq(1)
    end

    it "hands a save to Rails when the connection drops on every attempt, tried four times under one idempotency key" do
      stub_request(:post, STRIPE_ACCOUNTS_URL).to_return { |request| drop_connection(request) }

      save_payments

      expect(creation_requests).to have_been_made.times(4)
      expect(creation_keys.uniq.size).to eq(1)
      expect(payout_notes.last.json_data[StripeMerchantAccountManager::ACCOUNT_CREATION_IDEMPOTENCY_KEY]).to eq(creation_keys.first)
    end

    it "hands a save to Rails when the connection drops once and the retry creates the account" do
      stub_request(:post, STRIPE_ACCOUNTS_URL)
        .to_return { |request| drop_connection(request) }
        .then.to_return do |request|
          creation_keys << request.headers["Idempotency-Key"]
          { status: 200, body: created_account, headers: JSON_HEADERS }
        end

      save_payments

      expect(creation_requests).to have_been_made.twice
      expect(creation_keys.uniq.size).to eq(1)
      expect(seller.reload.stripe_account.charge_processor_merchant_id).to eq(created_account_id)
    end
  end
end
