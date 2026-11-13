# frozen_string_literal: true

require "spec_helper"

# The instant payout notice of the Payouts page for a seller whose bank account carries Stripe ids, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/payouts-instant-notice.replay.test.ts. BankAccount#supports_instant_payouts?
# reads the external account from Stripe; WebMock answers it, so nothing leaves the machine. The page asks twice (the instant payout
# props and the notice, each on a bank account record of its own), and the fixture's `http` holds both reads.
#
# Run with TZ=UTC, like payouts_signed_in_spec.rb.
describe "Payouts page instant payout notice", type: :request do
  include Parity::SignedInDashboard

  STRIPE_CONNECT_ACCOUNT_ID = "acct_parityinstant01"
  STRIPE_EXTERNAL_ACCOUNT_ID = "ba_parityinstant01"
  EXTERNAL_ACCOUNT_URL = "https://api.stripe.com/v1/accounts/#{STRIPE_CONNECT_ACCOUNT_ID}/external_accounts/#{STRIPE_EXTERNAL_ACCOUNT_ID}"

  let(:seller) { create(:user, name: "Instant Notice Seller", username: "instantnoticeseller") }
  let(:bank) do
    create(:ach_account, user: seller, stripe_connect_account_id: STRIPE_CONNECT_ACCOUNT_ID, stripe_bank_account_id: STRIPE_EXTERNAL_ACCOUNT_ID)
  end

  before do
    create(:merchant_account, user: nil)
    seller.update_columns(user_risk_state: "compliant")
    create(:user_compliance_info, user: seller)
    create(:merchant_account, user: seller, created_at: 90.days.ago)
    bank
    create(
      :payment_completed,
      user: seller, amount_cents: 5000, processor: PayoutProcessorType::STRIPE, currency: Currency::USD, bank_account: bank,
      stripe_transfer_id: "tr_payout_30", stripe_connect_account_id: "acct_payout_30",
      created_at: 30.days.ago, payout_period_end_date: Date.current - 33
    )
    create(:balance, user: seller, amount_cents: 12_000, date: Date.current - 20)
  end

  def stripe_answers(status, body)
    stub_request(:get, EXTERNAL_ACCOUNT_URL).to_return(status:, body: body.to_json, headers: { "Content-Type" => "application/json" })
  end

  def external_account(payout_methods)
    { id: STRIPE_EXTERNAL_ACCOUNT_ID, object: "bank_account", available_payout_methods: payout_methods }
  end

  def stripe_error(message, type: "invalid_request_error")
    { error: { message:, type: } }
  end

  def visit_payouts
    log_in(seller)
    get balance_path
  end

  def props = inertia_props_of(response)

  it "offers the notice when Stripe lists only standard payouts for the bank account", parity: true do
    stripe_answers(200, external_account(["standard"]))

    visit_payouts

    expect(props).to include("show_instant_payouts_notice" => true, "instant_payout" => nil)
    expect(a_request(:get, EXTERNAL_ACCOUNT_URL)).to have_been_made.twice
  end

  it "offers the notice when Stripe does not know the external account", parity: true do
    stripe_answers(404, stripe_error("No such external account: '#{STRIPE_EXTERNAL_ACCOUNT_ID}'"))
    expect(ErrorNotifier).not_to receive(:notify)

    visit_payouts

    expect(props).to include("show_instant_payouts_notice" => true, "instant_payout" => nil)
  end

  it "offers the notice and reports the error when Stripe refuses the read", parity: true do
    stripe_answers(400, stripe_error("The external account could not be read."))
    expect(ErrorNotifier).to receive(:notify).twice

    visit_payouts

    expect(props).to include("show_instant_payouts_notice" => true, "instant_payout" => nil)
  end

  it "asks Stripe nothing when the bank account has no external account id", parity: true do
    bank.update_columns(stripe_bank_account_id: nil)

    visit_payouts

    expect(props).to include("show_instant_payouts_notice" => true, "instant_payout" => nil)
    expect(a_request(:get, EXTERNAL_ACCOUNT_URL)).not_to have_been_made
  end

  it "asks Stripe nothing when the seller is not eligible", parity: true do
    seller.update_columns(user_risk_state: "not_reviewed")

    visit_payouts

    expect(props).to include("show_instant_payouts_notice" => false, "instant_payout" => nil)
    expect(a_request(:get, EXTERNAL_ACCOUNT_URL)).not_to have_been_made
  end

  it "serves the instant payout data and no notice when Stripe lists instant payouts", parity: true do
    stripe_answers(200, external_account(%w[standard instant]))
    stub_request(:get, %r{\Ahttps://api\.stripe\.com/v1/balance\?}).to_return(
      status: 200, headers: { "Content-Type" => "application/json" },
      body: { object: "balance", available: [{ amount: 1_000_000, currency: "usd" }], pending: [], instant_available: [{ amount: 1_000_000, currency: "usd", net_available: [{ amount: 1_000_000, destination: STRIPE_CONNECT_ACCOUNT_ID, source_types: { card: 1_000_000 } }] }] }.to_json
    )

    visit_payouts

    expect(props["show_instant_payouts_notice"]).to eq(false)
    expect(props["instant_payout"]).to include("instant_payout_fee_percent", "bank_name")
  end
end
