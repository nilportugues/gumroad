# frozen_string_literal: true

require "spec_helper"

# POST /instant_payouts for a seller with a seasoned Stripe account and a balance in the instant range, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/money-hand-backs.replay.test.ts. Stripe's answers are read back out of the
# cassette InstantPayoutsService's own spec recorded, served by WebMock in the order they were recorded, so nothing leaves the machine.
#
# The fixture's timeline is the order a port has to reproduce: the external-account read, the balance read, the Payment row, the
# Stripe payout (with its idempotency key) and the writes that follow it. Node does not port the request, so the example is a
# hand-back: the replay asserts the request reaches Rails whole with no Stripe call and no write from Node.
describe "Instant payouts", type: :request do
  include Parity::AudienceSignedIn

  INSTANT_PAYOUT_CASSETTE = Rails.root.join(
    "spec/support/fixtures/vcr_cassettes/InstantPayoutsService/_perform/with_stripe_account/" \
    "when_seller_has_a_balance_within_the_instant_payout_range/creates_and_processes_an_instant_payout.yml"
  )

  let(:seller) { create(:compliant_user, name: "Instant Seller", username: "instantseller") }

  before do
    host! DOMAIN
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
  end

  # The cassette's interactions grouped by request, each group answered in the order it was recorded (the last answer repeats).
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

  it "hands a seasoned Stripe account's instant payout to Rails", parity: true do
    stub_stripe_from_cassette(INSTANT_PAYOUT_CASSETTE)
    create(:tos_agreement, user: seller)
    create(:user_compliance_info, user: seller)
    create_list(:payment_completed, 4, user: seller)
    create(:ach_account_stripe_succeed, user: seller)
    merchant_account = StripeMerchantAccountManager.create_account(seller.reload, passphrase: "1234")
    merchant_account.update!(created_at: 90.days.ago)
    stripe_account = Stripe::Account.retrieve(merchant_account.charge_processor_merchant_id)
    stripe_account.refresh until stripe_account.payouts_enabled?
    allow(Stripe::Balance).to receive(:retrieve).and_call_original
    allow(Stripe::Balance).to receive(:retrieve).with({}, anything).and_return(
      Stripe::Balance.construct_from(object: "balance", available: [{ amount: 1_000_000_00, currency: "usd" }], pending: [{ amount: 0, currency: "usd" }])
    )
    Stripe::Transfer.create(destination: stripe_account.id, currency: "usd", amount: 1000_00)
    create(:balance, amount_cents: 1000_00, holding_amount_cents: 1000_00, user: seller, date: Date.yesterday, merchant_account:)
    log_in(seller)

    post instant_payouts_path, params: { date: Date.today.to_s }.to_json,
                               headers: { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "X-Inertia" => "true", "X-CSRF-Token" => csrf_token }

    expect(response).to redirect_to(balance_path)
    expect(flash[:notice]).to eq("Instant payout initiated successfully")
    expect(Payment.last).to have_attributes(payout_type: Payouts::PAYOUT_TYPE_INSTANT, state: "processing")
  end
end
