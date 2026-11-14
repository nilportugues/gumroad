# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::UsersController#info through the whole stack, on the API host with a per-actor token: the parts the controller
# spec cannot show because it stubs them (the Stripe call, the payout schedule). Recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are requests the port leaves to Rails:
# the replay asserts they reach the stand-in Rails untouched.
describe "Internal admin API user info", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:user) { create(:user, email: "subject@example.com", name: "Subject User", username: "subjectuser") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
    create(:merchant_account, user: nil) unless MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id)
  end

  def stripe_account(id, body)
    stub_request(:get, "https://api.stripe.com/v1/accounts/#{id}")
      .to_return(status: body.fetch(:status, 200), body: body.fetch(:json).to_json, headers: { "Content-Type" => "application/json" })
  end

  def connect_stripe_account(id)
    create(:merchant_account, user:, charge_processor_merchant_id: id)
  end

  describe "the payout schedule" do
    it "names the next payout date and its balance for a weekly seller above the minimum", parity: true do
      create(:balance, user:, amount_cents: 150_00, date: 30.days.ago.to_date)

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["user"]["payouts"]).to include("next_payout_date" => be_present, "balance_for_next_payout" => "$150")
    end

    it "has no next payout for a seller below the minimum", parity: true do
      create(:balance, user:, amount_cents: 50_00, date: 30.days.ago.to_date)

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["user"]["payouts"]).to include("next_payout_date" => nil, "balance_for_next_payout" => nil)
      expect(response.parsed_body["user"]["stats"]["unpaid_balance_formatted"]).to eq("$50.00")
    end

    it "words a monthly seller's next payout by their schedule", parity: true do
      user.update!(payout_frequency: User::PayoutSchedule::MONTHLY)
      create(:balance, user:, amount_cents: 150_00, date: 30.days.ago.to_date)

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["user"]["payouts"]["next_payout_date"]).to be_present
    end

    it "hands a daily seller above the minimum to Rails", parity: true do
      user.update!(payout_frequency: User::PayoutSchedule::DAILY)
      create(:balance, user:, amount_cents: 150_00, date: 30.days.ago.to_date)

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "Stripe" do
    it "reports the verification of a connected account", parity: true do
      connect_stripe_account("acct_info1")
      stripe_account("acct_info1", json: { id: "acct_info1", object: "account", charges_enabled: true, payouts_enabled: false, details_submitted: true, requirements: { disabled_reason: "requirements.past_due", currently_due: ["a"], past_due: %w[a b], pending_verification: [] } })

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["user"]["stripe"]["verification"]).to include("payouts_enabled" => false, "past_due_count" => 2)
    end

    it "reports an account Stripe holds nothing against", parity: true do
      connect_stripe_account("acct_info2")
      stripe_account("acct_info2", json: { id: "acct_info2", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { disabled_reason: nil, currently_due: [], past_due: [], pending_verification: [] } })

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["user"]["stripe"]["verification"]).to include("disabled_reason" => nil, "currently_due_count" => 0)
    end

    it "degrades to an error subfield when Stripe refuses the account", parity: true do
      connect_stripe_account("acct_info3")
      stripe_account("acct_info3", status: 403, json: { error: { type: "invalid_request_error", message: "The provided key does not have access to account 'acct_info3'" } })

      get "/internal/admin/users/info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["user"]["stripe"]["verification"]).to have_key("error")
    end
  end
end
