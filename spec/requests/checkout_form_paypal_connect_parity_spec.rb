# frozen_string_literal: true

require "spec_helper"

# Checkout::FormPresenter#paypal_connect for a seller who has merchant accounts, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/checkout-form-paypal.replay.test.ts. The replay answers PayPal from a local stand-in with the
# responses recorded here and asserts the calls Node made (method, URL, body, order) are the ones Rails made.
#
# The PayPal responses are not invented: they are read back out of VCR cassettes recorded against api.sandbox.paypal.com (a 200 token
# and merchant-integrations pair, and the 401 pair PayPal answers when the partner credentials are wrong).
describe "Checkout form PayPal Connect when signed in", type: :request do
  include Parity::AudienceSignedIn

  CASSETTES = Rails.root.join("spec/support/fixtures/vcr_cassettes")
  CONNECTED = CASSETTES.join("PaypalPayoutProcessor/is_user_payable/creator_has_not_set_a_payment_address/returns_true_if_creator_has_a_paypal_account_connected.yml")
  REFUSED = CASSETTES.join("Checkout_FormPresenter/_form_props/paypal_connect_props/when_the_seller_has_a_connected_PayPal_merchant_account/returns_the_merchant_account_details.yml")
  MERCHANT_ID = "B66YJBBNCRW6L"
  TOKEN_KEY = PaypalPartnerRestCredentials::TOKEN_KEY

  let(:seller) { create(:user, name: "Form Seller", username: "formseller", created_at: Time.utc(2025, 1, 1)) }

  before do
    host! DOMAIN
    create(:user_compliance_info, user: seller, country: "United States")
    seller.update_columns(payment_address: nil)
    $redis.flushdb
  end

  # Stubs the first token and merchant-integrations interaction of a cassette (`only:` narrows to one of the two).
  def stub_paypal(cassette, only: nil, body: nil, content_type: nil)
    interactions = YAML.safe_load_file(cassette, permitted_classes: [Symbol])["http_interactions"]
    picked = %w[post get].filter_map { |verb| interactions.find { |i| i["request"]["method"] == verb } }
    picked.each do |interaction|
      verb = interaction["request"]["method"].to_sym
      next if only && only != verb

      uri = interaction["request"]["uri"].sub("<PAYPAL_PARTNER_MERCHANT_ID>", GlobalConfig.get("PAYPAL_PARTNER_MERCHANT_ID"))
      response = interaction["response"]
      stub_request(verb, uri).to_return(
        status: response["status"]["code"],
        body: body && verb == :get ? body : response["body"]["string"],
        headers: { "Content-Type" => content_type && verb == :get ? content_type : response["headers"]["Content-Type"].first }
      )
    end
  end

  def connect_paypal(**attrs)
    create(:merchant_account_paypal, user: seller, charge_processor_merchant_id: MERCHANT_ID, **attrs)
  end

  def get_form
    log_in(seller)
    get checkout_form_path
  end

  def paypal_props = inertia_props_of(response)["paypal_connect"]

  def sign_in_as_team_member(role)
    member = create(:user, name: "Team #{role}")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "GET /checkout/form for a seller with a PayPal merchant account" do
    it "shows the email PayPal returns for the connected account", parity: true do
      connect_paypal(charge_processor_verified_at: Time.utc(2025, 1, 2))
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("show_paypal_connect" => true, "charge_processor_merchant_id" => MERCHANT_ID, "charge_processor_verified" => true,
                                      "email" => "sb-byx2u2205460@business.example.com", "needs_email_confirmation" => false)
      expect(WebMock).to have_requested(:post, %r{/v1/oauth2/token}).once
    end

    it "reuses the partner token cached in Redis and makes only the lookup", parity: true do
      connect_paypal
      $redis.set("paypal_partner_rest_auth_token:#{TOKEN_KEY}", "Bearer cached-partner-token")
      stub_paypal(CONNECTED, only: :get)

      get_form

      expect(paypal_props).to include("email" => "sb-byx2u2205460@business.example.com", "charge_processor_verified" => false)
      expect(WebMock).not_to have_requested(:post, %r{/v1/oauth2/token})
    end

    it "leaves the email out when PayPal refuses the partner credentials", parity: true do
      connect_paypal
      stub_paypal(REFUSED)

      get_form

      expect(paypal_props).to include("show_paypal_connect" => true, "charge_processor_merchant_id" => MERCHANT_ID, "email" => nil)
    end

    it "leaves the email out when the lookup answers with a JSON list", parity: true do
      connect_paypal
      stub_paypal(CONNECTED, body: "[]")

      get_form

      expect(paypal_props).to include("email" => nil)
    end

    it "leaves the email out when the lookup answers with JSON that does not parse", parity: true do
      connect_paypal
      stub_paypal(CONNECTED, body: "{not json")

      get_form

      expect(paypal_props).to include("email" => nil)
    end

    it "reads a lookup answered in plain text as a string", parity: true do
      connect_paypal
      stub_paypal(CONNECTED, body: "gateway primary_email timeout", content_type: "text/plain")

      get_form

      expect(paypal_props).to include("email" => "primary_email")
    end

    it "does not call PayPal for a team member who cannot connect PayPal", parity: true do
      connect_paypal
      sign_in_as_team_member(TeamMembership::ROLE_MARKETING)

      get checkout_form_path

      expect(paypal_props).to include("show_paypal_connect" => false, "charge_processor_merchant_id" => MERCHANT_ID, "email" => nil)
      expect(WebMock).not_to have_requested(:any, /paypal/)
    end

    it "flags an account whose PayPal email is not confirmed", parity: true do
      connect_paypal(meta: { "isEmailConfirmed" => "false" })
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("needs_email_confirmation" => true)
    end

    it "does not flag an account whose PayPal email is confirmed", parity: true do
      connect_paypal(meta: { "isEmailConfirmed" => "true" })
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("needs_email_confirmation" => false)
    end

    it "warns that disconnecting would leave a seller with no payout rail", parity: true do
      connect_paypal
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("allow_paypal_connect" => true, "paypal_disconnect_removes_payout_rail" => true, "paypal_disconnect_blocks_publishing" => true)
    end

    it "does not warn when the seller also has a payout email", parity: true do
      seller.update!(payment_address: "payouts@example.com")
      connect_paypal
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("paypal_disconnect_removes_payout_rail" => false, "paypal_disconnect_blocks_publishing" => false)
    end

    it "does not block publishing for a team member account", parity: true do
      seller.update_columns(flags: seller.flags | User.flag_mapping["flags"][:is_team_member])
      connect_paypal
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("paypal_disconnect_removes_payout_rail" => true, "paypal_disconnect_blocks_publishing" => false)
    end

    it "does not block publishing when the seller is also paid through a Stripe Connect account", parity: true do
      connect_paypal
      create(:merchant_account_stripe_connect, user: seller)
      seller.update!(check_merchant_account_is_linked: true)
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("paypal_disconnect_removes_payout_rail" => false, "paypal_disconnect_blocks_publishing" => false)
    end

    it "looks up an account whose charge processor was deleted but the row is alive", parity: true do
      connect_paypal(charge_processor_deleted_at: Time.utc(2025, 1, 3))
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("charge_processor_merchant_id" => MERCHANT_ID, "email" => "sb-byx2u2205460@business.example.com",
                                      "paypal_disconnect_removes_payout_rail" => false)
    end

    it "ignores a soft-deleted account", parity: true do
      connect_paypal.mark_deleted!

      get_form

      expect(paypal_props).to include("charge_processor_merchant_id" => nil, "email" => nil)
      expect(WebMock).not_to have_requested(:any, /paypal/)
    end

    it "shows the section to a seller from a grandfathered country that connected PayPal", parity: true do
      seller.alive_user_compliance_info.mark_deleted!
      create(:user_compliance_info, user: seller, country: "China")
      connect_paypal
      stub_paypal(CONNECTED)

      get_form

      expect(paypal_props).to include("show_paypal_connect" => true, "email" => "sb-byx2u2205460@business.example.com")
    end

    it "hides the section from a seller in a country PayPal Connect does not serve", parity: true do
      seller.alive_user_compliance_info.mark_deleted!
      create(:user_compliance_info, user: seller, country: "Brazil")
      connect_paypal

      get_form

      expect(paypal_props).to include("show_paypal_connect" => false, "charge_processor_merchant_id" => MERCHANT_ID)
      expect(WebMock).not_to have_requested(:any, /paypal/)
    end
  end
end
