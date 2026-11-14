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

    it "hands a save that carries compliance information to Rails", parity: true do
      with_compliance_info
      log_in(seller)

      save_settings(:put, user: { first_name: "Pat" })

      expect(response).to have_http_status(:see_other)
      expect(seller.alive_user_compliance_info.first_name).to eq("Pat")
    end

    it "notes a payout preferences save on the seller when a team admin makes it", parity: true do
      with_compliance_info
      as_team_member(:admin)

      save_settings(:put, payout_frequency: "monthly")

      expect(response).to have_http_status(:see_other)
      expect(seller.comments.last.content).to start_with("Payout settings updated by team admin")
    end

    context "with payout preferences only" do
      before do
        with_compliance_info
        log_in(seller)
      end

      it "saves the payout frequency", parity: true do
        save_settings(:put, payout_frequency: "monthly")

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
        expect(seller.reload.payout_frequency).to eq("monthly")
      end

      it "saves through PATCH", parity: true do
        save_settings(:patch, payout_frequency: "quarterly")

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payout_frequency).to eq("quarterly")
      end

      it "pauses payouts", parity: true do
        save_settings(:put, payouts_paused_by_user: true)

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payouts_paused_by_user?).to be(true)
      end

      it "resumes paused payouts", parity: true do
        seller.update!(payouts_paused_by_user: true)

        save_settings(:put, payouts_paused_by_user: false)

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payouts_paused_by_user?).to be(false)
      end

      it "saves the buyer currency switches", parity: true do
        save_settings(:put, disable_buyer_local_currency: true, disable_buyer_currency_rounding: true)

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.disable_buyer_local_currency).to be(true)
        expect(seller.disable_buyer_currency_rounding).to be(true)
      end

      it "saves a payout threshold sent as a number", parity: true do
        save_settings(:put, payout_threshold_cents: 25_000)

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payout_threshold_cents).to eq(25_000)
      end

      it "saves a payout threshold sent as text", parity: true do
        save_settings(:put, payout_threshold_cents: "27500", payout_frequency: "weekly")

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payout_threshold_cents).to eq("27500")
      end

      it "refuses a payout threshold under the minimum", parity: true do
        save_settings(:put, payout_threshold_cents: 1, payouts_paused_by_user: true)

        expect(response).to redirect_to(settings_payments_path)
        expect(seller.reload.payouts_paused_by_user?).to be(false)
      end

      it "refuses a payout frequency that is not offered", parity: true do
        save_settings(:put, payout_frequency: "hourly")

        expect(response).to redirect_to(settings_payments_path)
        expect(seller.reload.payout_frequency).to eq("weekly")
      end

      it "answers a save of nothing like any other", parity: true do
        save_settings(:put, {})

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Thanks! You're all set.")
      end

      it "hands a threshold that is not an integer to Rails", parity: true do
        save_settings(:put, payout_threshold_cents: "7500.5")

        expect(response).to have_http_status(:see_other)
      end

      it "hands a payment address to Rails", parity: true do
        save_settings(:put, payment_address: "seller@example.com", payout_frequency: "monthly")

        expect(response).to have_http_status(:see_other)
      end

      it "hands a seller with an active bank account to Rails, which creates the Stripe account", parity: true do
        create(:ach_account, user: seller)
        stub_request(:post, "https://api.stripe.com/v1/accounts")
          .to_return(status: 400, body: { error: { type: "invalid_request_error", message: "Invalid request." } }.to_json, headers: { "Content-Type" => "application/json" })

        save_settings(:put, payout_frequency: "monthly")

        expect(response).to redirect_to(settings_payments_path)
        expect(a_request(:post, "https://api.stripe.com/v1/accounts")).to have_been_made.once
      end

      it "saves for a seller who has a bank account and a Stripe account, which creates nothing", parity: true do
        create(:ach_account, user: seller)
        create(:merchant_account, user: seller, country: "US")

        save_settings(:put, payout_frequency: "monthly")

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.payout_frequency).to eq("monthly")
        expect(a_request(:post, "https://api.stripe.com/v1/accounts")).not_to have_been_made
      end

      it "hands a seller with a stored military ZIP code to Rails", parity: true do
        seller.alive_user_compliance_info.update_columns(zip_code: "09001")

        save_settings(:put, payout_frequency: "monthly")

        expect(response).to have_http_status(:see_other)
      end
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

    it "sets the first country of a seller with no compliance information and moves the currency to it", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "CA")

      expect(response).to have_http_status(:no_content)
      expect(seller.alive_user_compliance_info.country).to eq("Canada")
      expect(seller.reload.currency_type).to eq("cad")
    end

    it "sets a first country whose default currency is the seller's own", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "US")

      expect(response).to have_http_status(:no_content)
      expect(seller.alive_user_compliance_info.country).to eq("United States")
    end

    it "supersedes a revision that has no country", parity: true do
      with_compliance_info(country: nil, first_name: "Pat", last_name: "Seller", street_address: "1 Main St")
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "GB")

      expect(response).to have_http_status(:no_content)
      expect(seller.user_compliance_infos.count).to eq(2)
      expect(seller.alive_user_compliance_info.first_name).to eq("Pat")
    end

    it "notes the country on the seller when a team admin sets it", parity: true do
      as_team_member(:admin)

      post_json(set_country_settings_payments_path, country: "DE")

      expect(response).to have_http_status(:no_content)
      expect(seller.comments.last.content).to start_with("Compliance country set by team admin")
    end

    it "saves a revision with no country for a country that is not text", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: ["PR"])

      expect(response).to have_http_status(:no_content)
      expect(seller.user_compliance_infos.count).to eq(2)
      expect(seller.alive_user_compliance_info.country).to be_nil
    end

    it "saves a revision with no country for a country code the ISO list does not know", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "ZZ")

      expect(response).to have_http_status(:no_content)
      expect(seller.alive_user_compliance_info.country).to be_nil
      expect(seller.reload.currency_type).to eq("usd")
    end

    it "saves a revision with no country when no country is sent", parity: true do
      with_compliance_info(country: nil, first_name: "Pat", last_name: "Seller")
      log_in(seller)

      post_json(set_country_settings_payments_path)

      expect(response).to have_http_status(:no_content)
      expect(seller.user_compliance_infos.count).to eq(2)
      expect(seller.alive_user_compliance_info.first_name).to eq("Pat")
    end

    it "reads a country code in any case", parity: true do
      log_in(seller)

      post_json(set_country_settings_payments_path, country: "de")

      expect(response).to have_http_status(:no_content)
      expect(seller.alive_user_compliance_info.country).to eq("Germany")
      expect(seller.reload.currency_type).to eq("eur")
    end
  end

  describe "POST /settings/payments/remove_credit_card" do
    it "refuses a support member", parity: true do
      as_team_member(:support)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:unauthorized)
    end

    def give_seller_a_card
      seller.update_columns(credit_card_id: create(:indian_stripe_credit_card).id)
    end

    def save_purchase(**attributes)
      purchase = build(:purchase, purchaser: seller, purchase_state: "successful", **attributes)
      purchase.save!(validate: false)
      purchase
    end

    it "clears the saved card", parity: true do
      give_seller_a_card
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
      expect(seller.reload.credit_card_id).to be_nil
    end

    it "clears the saved card of a seller who has no card", parity: true do
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
    end

    it "notes the removal on the seller when a team admin removes the card", parity: true do
      give_seller_a_card
      as_team_member(:admin)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
      expect(seller.comments.last.content).to start_with("Payout settings updated by team admin")
    end

    it "keeps the card of a seller with a preorder authorization", parity: true do
      give_seller_a_card
      save_purchase(purchase_state: "preorder_authorization_successful")
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:bad_request)
      expect(seller.reload.credit_card_id).not_to be_nil
    end

    it "keeps the card of a seller with a live paid subscription", parity: true do
      give_seller_a_card
      subscription = create(:subscription, user: seller)
      save_purchase(subscription:, is_original_subscription_purchase: true)
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:bad_request)
      expect(seller.reload.credit_card_id).not_to be_nil
    end

    it "clears the card of a seller whose only subscription is a test purchase", parity: true do
      give_seller_a_card
      subscription = create(:subscription, user: seller)
      save_purchase(subscription:, is_original_subscription_purchase: true, purchase_state: "test_successful")
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
      expect(seller.reload.credit_card_id).to be_nil
    end

    it "clears the card of a seller whose subscription ended", parity: true do
      give_seller_a_card
      subscription = create(:subscription, user: seller)
      save_purchase(subscription:, is_original_subscription_purchase: true)
      subscription.update_columns(ended_at: 1.day.ago)
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:no_content)
    end

    it "answers with the validation errors when the seller no longer saves", parity: true do
      give_seller_a_card
      seller.update_columns(name: "n" * 101)
      log_in(seller)

      post_json(remove_credit_card_settings_payments_path)

      expect(response).to have_http_status(:bad_request)
      expect(seller.reload.credit_card_id).not_to be_nil
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

    context "with a PayPal merchant id of the seller" do
      let(:paypal_merchant_id) { "PAYPALMERCHANT" }
      let(:json_content_type) { { "Content-Type" => "application/json" } }
      let(:connect_params) do
        { merchantIdInPayPal: paypal_merchant_id, merchantId: "#{seller.external_id}-1", permissionsGranted: "true", accountStatus: "BUSINESS_ACCOUNT", consentStatus: "true", isEmailConfirmed: "true" }
      end

      before { seller.update_column(:payment_address, "payouts@example.com") }

      def stub_paypal_token
        stub_request(:post, "#{PAYPAL_REST_ENDPOINT}/v1/oauth2/token")
          .to_return(status: 200, body: { token_type: "Bearer", access_token: "A21AAtestpartnertoken", expires_in: 32_400 }.to_json, headers: json_content_type)
      end

      def paypal_details(**overrides)
        {
          merchant_id: paypal_merchant_id,
          primary_email: "connected@example.com",
          primary_email_confirmed: true,
          payments_receivable: true,
          country: "US",
          primary_currency: "USD",
          oauth_integrations: [{ integration_type: "OAUTH_THIRD_PARTY", integration_method: "PAYPAL", oauth_third_party: [{ partner_client_id: PAYPAL_PARTNER_CLIENT_ID }] }],
        }.merge(overrides)
      end

      def stub_paypal_merchant(status: 200, **overrides)
        stub_paypal_token
        stub_request(:get, "#{PAYPAL_REST_ENDPOINT}/v1/customer/partners/#{PAYPAL_PARTNER_ID}/merchant-integrations/#{paypal_merchant_id}")
          .to_return(status:, body: paypal_details(**overrides).to_json, headers: json_content_type)
      end

      def connect
        get paypal_connect_settings_payments_path, params: connect_params
      end

      it "connects an account PayPal reports as ready to receive payments", parity: true do
        stub_paypal_merchant
        log_in(seller)

        connect

        expect(response).to redirect_to(checkout_form_path)
        expect(flash[:notice]).to eq("You have successfully connected your PayPal account with Gumroad.")
        expect(seller.merchant_accounts.paypal.alive.sole).to be_charge_processor_verified
      end

      it "connects an account when the token is already cached", parity: true do
        stub_paypal_merchant
        PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer A21AAcachedtoken")
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("You have successfully connected your PayPal account with Gumroad.")
      end

      it "takes the country and currency PayPal reports", parity: true do
        stub_paypal_merchant(country: "GB", primary_currency: "GBP")
        log_in(seller)

        connect

        account = seller.merchant_accounts.paypal.alive.sole
        expect([account.country, account.currency]).to eq(%w[GB gbp])
      end

      it "reads the country code PayPal uses for China as China, where the integration is not supported", parity: true do
        stub_paypal_merchant(country: "C2", primary_currency: "CNY")
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("Your PayPal account could not be connected because this PayPal integration is not supported in your country.")
      end

      it "removes the seller's other PayPal accounts once one is verified", parity: true do
        create(:merchant_account_paypal, user: seller, charge_processor_merchant_id: "OLDMERCHANT")
        stub_paypal_merchant
        log_in(seller)

        connect

        expect(seller.merchant_accounts.paypal.alive.pluck(:charge_processor_merchant_id)).to eq([paypal_merchant_id])
      end

      it "asks the seller to confirm the PayPal email address", parity: true do
        stub_paypal_merchant(primary_email_confirmed: false, payments_receivable: false)
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("You need to confirm the email address (connected@example.com) attached to your PayPal account before you can start using it with Gumroad.")
      end

      it "tells the seller PayPal cannot receive payments right now", parity: true do
        stub_paypal_merchant(payments_receivable: false)
        log_in(seller)

        connect

        expect(flash[:notice]).to start_with("PayPal reports that your account cannot receive payments right now.")
      end

      it "tells the seller the permissions are missing", parity: true do
        stub_paypal_merchant(oauth_integrations: [])
        log_in(seller)

        connect

        expect(flash[:notice]).to start_with("Your PayPal account connect with Gumroad is incomplete because of missing permissions.")
      end

      it "turns away an account from a country PayPal Commerce Platform does not support", parity: true do
        stub_paypal_merchant(country: "BR", primary_currency: "BRL")
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("Your PayPal account could not be connected because this PayPal integration is not supported in your country.")
        expect(seller.merchant_accounts.paypal.alive).to be_empty
      end

      it "turns away an email address PayPal refuses to pay", parity: true do
        create(:payment, user: seller, processor: PayoutProcessorType::PAYPAL, payment_address: "connected@example.com", state: Payment::FAILED, failure_reason: Payment::FailureReason::TERMINAL_PAYPAL_FAILURE_REASONS.first)
        stub_paypal_merchant
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("PayPal won't accept payouts to that account. Please connect a different PayPal account.")
        expect(seller.merchant_accounts.paypal.alive).to be_empty
      end

      it "answers with nothing when PayPal cannot describe the account", parity: true do
        stub_paypal_merchant(status: 500)
        log_in(seller)

        connect

        expect(response).to redirect_to(checkout_form_path)
        expect(flash[:notice]).to be_nil
      end

      it "leaves a verified account alone without asking PayPal", parity: true do
        create(:merchant_account_paypal, user: seller, charge_processor_merchant_id: paypal_merchant_id, charge_processor_verified_at: Time.current, meta: { "merchantId" => "#{seller.external_id}-1" })
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("You have successfully connected your PayPal account with Gumroad.")
      end

      it "brings back a deleted account for the same merchant", parity: true do
        deleted = create(:merchant_account_paypal, user: seller, charge_processor_merchant_id: paypal_merchant_id)
        deleted.delete_charge_processor_account!
        stub_paypal_merchant
        log_in(seller)

        connect

        expect(deleted.reload).to be_alive
        expect(deleted).to be_charge_processor_verified
      end

      it "refuses a seller with no way of being paid", parity: true do
        seller.update_column(:payment_address, "")
        log_in(seller)

        connect

        expect(flash[:notice]).to eq("Your PayPal account could not be connected because you do not meet the eligibility requirements.")
      end

      it "notes the connection on the seller when a team admin makes it", parity: true do
        stub_paypal_merchant
        as_team_member(:admin)

        connect

        expect(seller.comments.last.content).to start_with("PayPal account connection updated by team admin")
      end
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
