# frozen_string_literal: true

require "spec_helper"

# PUT /settings/payments for a US individual with a bank account and no Stripe account yet, which makes Rails create the account
# (StripeMerchantAccountManager.create_account), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/money-hand-backs.replay.test.ts. Stripe's answers are read back out of the cassette the manager's own spec
# recorded and served by WebMock, so nothing leaves the machine.
#
# The fixture's timeline is the order a port has to reproduce: the writes before the account is created, the `POST /v1/accounts` with
# its idempotency key, and the writes after it. Node does not port the creation, so the example is a hand-back: the replay asserts the
# request reaches Rails whole with no Stripe call and no write from Node.
describe "Settings::PaymentsController Stripe account creation", type: :request do
  include Parity::AudienceSignedIn

  ACCOUNT_CREATION_CASSETTE = Rails.root.join(
    "spec/support/fixtures/vcr_cassettes/StripeMerchantAccountManager/_create_account/all_info_provided_of_an_individual/" \
    "creates_an_account_at_stripe_with_all_the_params.yml"
  )

  let(:seller) { create(:user, name: "Account Seller", username: "accountseller", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings/payments" }
  end

  before { host! DOMAIN }

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

  it "hands a save by a US individual with a bank account, which creates the Stripe account, to Rails", parity: true do
    stub_stripe_from_cassette(ACCOUNT_CREATION_CASSETTE)
    create(:user_compliance_info, user: seller)
    create(:ach_account_stripe_succeed, user: seller)
    log_in(seller)

    put settings_payments_path, params: { payout_frequency: "monthly" }.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)

    expect(response).to have_http_status(:see_other)
    expect(seller.reload.stripe_account).to be_present
    expect(a_request(:post, "https://api.stripe.com/v1/accounts")).to have_been_made.once
  end
end
