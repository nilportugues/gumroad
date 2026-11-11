# frozen_string_literal: true

require "spec_helper"

# The guards Node answers for the payout actions that move money, call Stripe or enqueue a job (POST /settings/stripe/disconnect,
# POST /instant_payouts, the tax form download and transaction report, GET /oauth_completions/stripe), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/payouts-guards.replay.test.ts, which sends the last request of each example.
# An example named "hands a ..." records what Node passes to Rails whole.
describe "Payout guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Payouts Guard Seller", username: "payoutsguard", created_at: Time.utc(2022, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/payouts" }
  end
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def post_json(path)
    token = csrf_token
    post path, headers: json_headers.merge("X-CSRF-Token" => token)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def with_tax_center
    create(:user_compliance_info, user: seller)
  end

  describe "POST /settings/stripe/disconnect" do
    it "refuses an accountant team member", parity: true do
      as_team_member(:accountant)

      post_json disconnect_settings_stripe_path

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a support team member with the role in the message", parity: true do
      as_team_member(:support)

      post_json disconnect_settings_stripe_path

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to include("Support")
    end

    it "hands a disconnect by the owner to Rails", parity: true do
      allow(StripeMerchantAccountManager).to receive(:disconnect).and_return(false)
      log_in(seller)

      post_json disconnect_settings_stripe_path

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a disconnect by an admin team member to Rails", parity: true do
      allow(StripeMerchantAccountManager).to receive(:disconnect).and_return(false)
      as_team_member(:admin)

      post_json disconnect_settings_stripe_path

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "POST /instant_payouts" do
    def request_instant_payout
      token = csrf_token
      post instant_payouts_path, params: { date: "2024-01-01" }.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token)
    end

    it "sends a support team member to the dashboard with the role in the message", parity: true do
      as_team_member(:support)

      request_instant_payout

      expect(response).to redirect_to(dashboard_path)
      expect(flash[:alert]).to include("Support")
    end

    it "sends a marketing team member to the dashboard", parity: true do
      as_team_member(:marketing)

      request_instant_payout

      expect(response).to redirect_to(dashboard_path)
    end

    it "hands a request by the owner to Rails", parity: true do
      allow_any_instance_of(InstantPayoutsService).to receive(:perform).and_return(success: false, error: "No balance")
      log_in(seller)

      request_instant_payout

      expect(response).to redirect_to(balance_path)
    end

    it "hands a request by an accountant team member to Rails", parity: true do
      allow_any_instance_of(InstantPayoutsService).to receive(:perform).and_return(success: false, error: "No balance")
      as_team_member(:accountant)

      request_instant_payout

      expect(response).to redirect_to(balance_path)
    end
  end

  describe "GET /payouts/taxes/:year/:form_type/download" do
    it "sends a seller without a US compliance record to the dashboard", parity: true do
      create(:user_compliance_info, user: seller, country: "Canada")
      log_in(seller)

      get download_tax_form_path(2024, "us_1099_k")

      expect(response).to redirect_to(dashboard_path)
      expect(flash[:alert]).to eq("Tax center is not enabled for your account.")
    end

    it "sends a seller without any compliance record to the dashboard", parity: true do
      log_in(seller)

      get download_tax_form_path(2024, "us_1099_k")

      expect(response).to redirect_to(dashboard_path)
    end

    it "sends a marketing team member to the dashboard", parity: true do
      with_tax_center
      as_team_member(:marketing)

      get download_tax_form_path(2024, "us_1099_k")

      expect(response).to redirect_to(dashboard_path)
      expect(flash[:alert]).to include("Marketing")
    end

    it "sends a seller without a tax form for the year back to the tax center", parity: true do
      with_tax_center
      log_in(seller)

      get download_tax_form_path(2024, "us_1099_k")

      expect(response).to redirect_to(tax_center_path(year: 2024))
      expect(flash[:alert]).to eq("Tax form not available for download.")
    end

    it "sends a seller whose form is of another type back to the tax center", parity: true do
      with_tax_center
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k")
      log_in(seller)

      get download_tax_form_path(2024, "us_1099_misc")

      expect(response).to redirect_to(tax_center_path(year: 2024))
    end

    it "reads a year that is not a number as zero", parity: true do
      with_tax_center
      log_in(seller)

      get download_tax_form_path("abc", "us_1099_k")

      expect(response).to redirect_to(tax_center_path(year: 0))
    end

    it "lets an accountant team member ask for a form the seller does not have", parity: true do
      with_tax_center
      as_team_member(:accountant)

      get download_tax_form_path(2023, "us_1099_k")

      expect(response).to redirect_to(tax_center_path(year: 2023))
    end

    it "hands a download of an existing form to Rails", parity: true do
      with_tax_center
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k")
      allow_any_instance_of(StripeTaxFormsApi).to receive(:download_tax_form).and_return(nil)
      log_in(seller)

      get download_tax_form_path(2024, "us_1099_k")

      expect(response).to redirect_to(tax_center_path(year: 2024))
    end
  end

  describe "POST /payouts/taxes/:year/transaction_report" do
    it "sends a seller without a US compliance record to the dashboard", parity: true do
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to redirect_to(dashboard_path)
    end

    it "refuses a marketing team member", parity: true do
      with_tax_center
      as_team_member(:marketing)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 when the seller has no 1099-K for the year", parity: true do
      with_tax_center
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Transaction report not available.")
    end

    it "answers 404 when the form is a 1099-MISC", parity: true do
      with_tax_center
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_payouts_guard_1")
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_misc")
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the seller has no Stripe account", parity: true do
      with_tax_center
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k")
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the form names an account the seller does not have", parity: true do
      with_tax_center
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_payouts_guard_2")
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k", stripe_account_id: "acct_someone_else")
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a report for the seller's Stripe account to Rails", parity: true do
      with_tax_center
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_payouts_guard_3")
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k")
      log_in(seller)

      post_json tax_form_transaction_report_path(2024)

      expect(response.parsed_body).to eq("success" => true)
      expect(TaxFormTransactionReportJob.jobs.size).to eq(1)
    end

    it "hands a report for an account the form names to Rails", parity: true do
      with_tax_center
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_payouts_guard_4")
      create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_k", stripe_account_id: "acct_payouts_guard_4")
      as_team_member(:support)

      post_json tax_form_transaction_report_path(2024)

      expect(response.parsed_body).to eq("success" => true)
    end
  end

  describe "GET /oauth_completions/stripe" do
    it "sends a visitor without a Stripe connect session to the payments settings with an alert", parity: true do
      log_in(seller)

      get oauth_completions_stripe_path

      expect(response).to redirect_to(settings_payments_path)
      expect(flash[:alert]).to eq("Invalid OAuth session")
    end
  end
end
