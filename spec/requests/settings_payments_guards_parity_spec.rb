# frozen_string_literal: true

require "spec_helper"

# The guards of Settings::PaymentsController that Node answers (#update, #set_country, #paypal_connect, #remove_credit_card,
# #remediation and #verify_stripe_remediation), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-payments-guards.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole.
describe "Settings::PaymentsController guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Payments Guard Seller", username: "paymentsguard", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings/payments" }
  end
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def save_settings(method, body)
    token = csrf_token
    public_send(method, settings_payments_path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def post_json(path, body = {})
    token = csrf_token
    post path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => token)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def with_compliance_info(**attributes)
    create(:user_compliance_info, user: seller, **attributes)
  end

  describe "PUT /settings/payments" do
    it "refuses a switch of the country of the account to Puerto Rico", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, user: { updated_country_code: "PR" })

      expect(response).to redirect_to(settings_payments_path)
      expect(seller.alive_user_compliance_info.country).to eq("United States")
    end

    it "refuses a personal country of Puerto Rico", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, user: { country: "PR", zip_code: "94107" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "refuses a business country of Puerto Rico", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:patch, user: { is_business: true, business_country: "PR" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "refuses a switch of the country of the account to a French overseas department", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, user: { updated_country_code: "GP" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "refuses a business country in a French overseas department", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, user: { business_country: "MQ" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "refuses a seller whose email is not confirmed", parity: true do
      with_compliance_info
      as_team_member(:admin)
      seller.update_columns(email: nil)

      save_settings(:put, user: { updated_country_code: "PR" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "lets an admin member through to the guards", parity: true do
      with_compliance_info
      as_team_member(:admin)

      save_settings(:put, user: { updated_country_code: "PR" })

      expect(response).to redirect_to(settings_payments_path)
    end

    it "sends a marketing member to the dashboard", parity: true do
      with_compliance_info
      as_team_member(:marketing)

      save_settings(:put, user: { updated_country_code: "PR" })

      expect(response).to redirect_to(dashboard_path)
    end

    it "answers no content to a seller with no country", parity: true do
      log_in(seller)

      save_settings(:put, user: { country: "PR" })

      expect(response).to have_http_status(:no_content)
    end

    it "hands a save that passes the guards to Rails", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, payout_frequency: "weekly")

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.payout_frequency).to eq("weekly")
    end
  end

  describe "POST /settings/payments/set_country" do
    it "answers 403 to a seller who already has a country", parity: true do
      with_compliance_info
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "CA")

      expect(response).to have_http_status(:forbidden)
      expect(response.body).to eq("")
    end

    it "answers 403 to Puerto Rico", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "PR")

      expect(response).to have_http_status(:forbidden)
      expect(response.body).to eq("")
    end

    it "answers 403 with the message to a French overseas department", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "GP")

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("error" => "French overseas departments are not valid compliance countries. Select France instead.")
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      post_json(set_country_settings_payments_path, country: "CA")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a first country to Rails", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "CA")

      expect(response).to have_http_status(:no_content)
      expect(seller.alive_user_compliance_info.country).to eq("Canada")
    end

    it "hands a country that is not text to Rails", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: ["PR"])

      expect(response).to have_http_status(:no_content)
    end
  end

  describe "POST /settings/payments/remove_credit_card" do
    it "refuses a support member", parity: true do
      as_team_member(:support)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands the removal to Rails", parity: true do
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
    end
  end

  describe "GET /settings/payments/paypal_connect" do
    it "sends a request with no PayPal merchant id back to the checkout form", parity: true do
      log_in(seller)

      get paypal_connect_settings_payments_path, params: { merchantId: "#{seller.external_id}-1" }

      expect(response).to redirect_to(checkout_form_path)
      expect(flash[:notice]).to eq("There was an error connecting your PayPal account with Gumroad.")
    end

    it "sends a request with no merchant id back to the checkout form", parity: true do
      log_in(seller)

      get paypal_connect_settings_payments_path, params: { merchantIdInPayPal: "PAYPALMERCHANT" }

      expect(response).to redirect_to(checkout_form_path)
    end

    it "sends the merchant id of another seller back to the checkout form", parity: true do
      log_in(seller)

      get paypal_connect_settings_payments_path, params: { merchantIdInPayPal: "PAYPALMERCHANT", merchantId: "someoneelse-1" }

      expect(response).to redirect_to(checkout_form_path)
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      get paypal_connect_settings_payments_path, params: { merchantIdInPayPal: "PAYPALMERCHANT", merchantId: "#{seller.external_id}-1" }

      expect(response).to redirect_to(dashboard_path)
    end

    it "hands the merchant id of the seller to Rails", parity: true do
      allow_any_instance_of(PaypalMerchantAccountManager).to receive(:update_merchant_account).and_return("PayPal account linked")
      log_in(seller)

      get paypal_connect_settings_payments_path, params: { merchantIdInPayPal: "PAYPALMERCHANT", merchantId: "#{seller.external_id}-1" }

      expect(response).to redirect_to(checkout_form_path)
      expect(flash[:notice]).to eq("PayPal account linked")
    end
  end

  describe "GET /settings/payments/remediation" do
    it "tells a seller with no Stripe account that they are all set", parity: true do
      log_in(seller)

      get remediation_settings_payments_path

      expect(response).to redirect_to(settings_payments_path)
      expect(flash[:notice]).to eq("Thanks! You're all set.")
    end

    it "ignores a Stripe Connect account", parity: true do
      create(:merchant_account_stripe_connect, user: seller)
      log_in(seller)

      get remediation_settings_payments_path

      expect(response).to redirect_to(settings_payments_path)
      expect(flash[:notice]).to eq("Thanks! You're all set.")
    end

    it "sends a rejected account with nothing to submit to the payments page", parity: true do
      create(:merchant_account, user: seller, country: "US", json_data: { "stripe_disabled_reason" => "rejected.fraud" })
      log_in(seller)

      get remediation_settings_payments_path

      expect(response).to redirect_to(settings_payments_path)
      expect(flash[:notice]).to be_nil
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      get remediation_settings_payments_path

      expect(response).to redirect_to(dashboard_path)
    end

    context "with a Stripe account" do
      let(:stripe_account_id) { "acct_remediation" }
      let(:link_url) { "https://connect.stripe.com/setup/e/acct_remediation/parity" }

      before { create(:merchant_account, user: seller, country: "US", charge_processor_merchant_id: stripe_account_id) }

      def stripe_account_json(requirements: {}, **account)
        { id: stripe_account_id, object: "account", charges_enabled: true, payouts_enabled: true, requirements: }.merge(account)
      end

      def stub_stripe_account(**attributes)
        stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_account_id}")
          .to_return(status: 200, body: stripe_account_json(**attributes).to_json, headers: { "Content-Type" => "application/json" })
      end

      def stub_account_link(status: 200, body: { object: "account_link", url: link_url })
        stub_request(:post, "https://api.stripe.com/v1/account_links")
          .to_return(status:, body: body.to_json, headers: { "Content-Type" => "application/json" })
      end

      it "sends a seller whose account has information due to a Stripe account update link", parity: true do
        stub_stripe_account(requirements: { currently_due: ["individual.id_number"] })
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "sends a seller with a verification document due to a Stripe onboarding link", parity: true do
        stub_stripe_account(requirements: { currently_due: ["individual.verification.document"], past_due: [] })
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "sends a seller with only future requirements due to a link", parity: true do
        stub_stripe_account(future_requirements: { eventually_due: ["business_profile.url"] })
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "offers a link to a seller whose review Stripe has left without a way out", parity: true do
        stub_stripe_account(charges_enabled: false, requirements: { pending_verification: ["individual.dob.day"], errors: [], current_deadline: nil })
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "skips the open requirements check for a seller with a pending request of their own", parity: true do
        create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested")
        stub_stripe_account
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "tells a seller with nothing open at Stripe that they are all set", parity: true do
        stub_stripe_account
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
      end

      it "treats a review that is still running as nothing to submit", parity: true do
        stub_stripe_account(requirements: { pending_verification: ["individual.dob.day"], current_deadline: nil }, payouts_enabled: true)
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
      end

      it "tells a seller whose payouts Stripe paused that there is nothing to submit", parity: true do
        seller.update!(payouts_paused_internally: true, payouts_paused_by: User::PAYOUT_PAUSE_SOURCE_STRIPE)
        stub_stripe_account
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:alert]).to eq("Stripe has paused payouts on your account and hasn't told us what it needs. There's nothing for you to submit right now.")
      end

      it "treats an account Stripe refuses to read as having nothing open", parity: true do
        stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_account_id}")
          .to_return(status: 400, body: { error: { type: "invalid_request_error", message: "No such account: '#{stripe_account_id}'", code: "resource_missing" } }.to_json, headers: { "Content-Type" => "application/json" })
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
      end

      it "falls back to the update link when the account cannot be read again for the link type", parity: true do
        create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested")
        stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_account_id}")
          .to_return(status: 400, body: { error: { type: "invalid_request_error", message: "No such account", code: "resource_missing" } }.to_json, headers: { "Content-Type" => "application/json" })
        stub_account_link
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(link_url)
      end

      it "sends a seller whose account Stripe rejected back to the payments page", parity: true do
        seller.stripe_account.update!(stripe_disabled_reason: "rejected.listed")
        create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested")
        stub_stripe_account
        stub_account_link(status: 400, body: { error: { type: "invalid_request_error", message: "An account link cannot be created for this account because the account has been rejected." } })
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:alert]).to be_nil
      end

      it "tells a seller that the verification page could not be opened", parity: true do
        seller.stripe_account.update!(stripe_disabled_reason: "requirements.past_due")
        stub_stripe_account(requirements: { currently_due: ["individual.id_number"] })
        stub_account_link(status: 400, body: { error: { type: "invalid_request_error", message: "Something else went wrong" } })
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:alert]).to eq("We couldn't open the verification page. Please contact support.")
      end

      it "hands a link Stripe refuses for an account with no recorded disabled reason to Rails", parity: true do
        stub_stripe_account(requirements: { currently_due: ["individual.id_number"], disabled_reason: "rejected.fraud" })
        stub_account_link(status: 400, body: { error: { type: "invalid_request_error", message: "An account link cannot be created for this account because the account has been rejected." } })
        log_in(seller)

        get remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(seller.stripe_account.reload.stripe_disabled_reason).to eq("rejected.fraud")
      end
    end
  end

  describe "GET /settings/payments/verify_stripe_remediation" do
    it "sends a seller with no Stripe account to the payments page", parity: true do
      log_in(seller)

      get verify_stripe_remediation_settings_payments_path

      expect(response).to redirect_to(settings_payments_path)
      expect(flash[:notice]).to be_nil
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      get verify_stripe_remediation_settings_payments_path

      expect(response).to redirect_to(dashboard_path)
    end

    context "with a Stripe account" do
      let(:stripe_account_id) { "acct_remediation" }

      before { create(:merchant_account, user: seller, country: "US", charge_processor_merchant_id: stripe_account_id) }

      def stub_stripe_account(**account)
        stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_account_id}")
          .to_return(status: 200, body: { id: stripe_account_id, object: "account", charges_enabled: true, payouts_enabled: true, requirements: {} }.merge(account).to_json, headers: { "Content-Type" => "application/json" })
      end

      def create_pending_request
        create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested")
      end

      it "sends a seller whose account still has information due back to the payments page", parity: true do
        create_pending_request
        stub_stripe_account(requirements: { currently_due: ["individual.id_number"] })
        log_in(seller)

        get verify_stripe_remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to be_nil
        expect(seller.user_compliance_info_requests.requested.count).to eq(1)
      end

      it "tells a seller with nothing open that they are all set", parity: true do
        stub_stripe_account
        log_in(seller)

        get verify_stripe_remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
      end

      it "tells a seller whose review is still running that Stripe is reviewing", parity: true do
        stub_stripe_account(charges_enabled: false, requirements: { pending_verification: ["individual.dob.day"], errors: [], current_deadline: nil })
        log_in(seller)

        get verify_stripe_remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:info]).to eq("Stripe is still reviewing your account. There's nothing more for you to submit right now.")
      end

      it "leaves the all set notice off while only eventual requirements are open", parity: true do
        stub_stripe_account(requirements: { eventually_due: ["business_profile.url"] })
        log_in(seller)

        get verify_stripe_remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(flash[:notice]).to be_nil
      end

      it "hands a seller with requests Stripe no longer asks for to Rails", parity: true do
        create_pending_request
        stub_stripe_account
        log_in(seller)

        get verify_stripe_remediation_settings_payments_path

        expect(response).to redirect_to(settings_payments_path)
        expect(seller.user_compliance_info_requests.requested.count).to eq(0)
      end
    end
  end
end
