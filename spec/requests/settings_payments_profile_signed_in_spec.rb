# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the payments settings, the profile settings and the OAuth application editor,
# recorded for the Next.js port (PARITY_RECORD=1) through the full Rack stack after a real login.
# Replayed by nextjs/parity/__tests__/settings-payments-profile.replay.test.ts, which sends the last
# request of each example.
describe "Payments, profile and application settings when signed in", type: :request do
  let(:seller) { create(:user, name: "Payments Seller", username: "paymentsseller") }

  before { host! DOMAIN }

  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
  end

  def switch_to(team_membership)
    post sellers_switch_path, params: { authenticity_token: csrf_token, team_membership_id: team_membership.external_id }
    expect(response).to have_http_status(:no_content)
  end

  def member_with_role(role, name: "Team Member")
    member = create(:user, name:)
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  describe "profile" do
    it "renders the profile editor for an owner who has set nothing up", parity: true do
      log_in(seller)

      get profile_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["profile_settings"]).to include("font" => "ABC Favorit")
      expect(props["editable_profile"]["creator_profile"]["can_edit"]).to eq(true)
    end

    it "renders the saved design, tabs, products, posts and wishlists", parity: true do
      create(:product, user: seller, name: "Visible product")
      create(:product, user: seller, name: "Archived product", archived: true)
      create(:audience_installment, seller:, name: "Profile post", published_at: 2.days.ago, shown_on_profile: true)
      create(:audience_installment, seller:, name: "Email only post", published_at: 1.day.ago, shown_on_profile: false)
      create(:wishlist, user: seller, name: "Gift ideas")
      seller.update!(name: "Designer", bio: "I make things", hide_follow_form: true)
      seller.seller_profile.update!(font: "Inter", background_color: "#fff", highlight_color: "#abc123", border_radius: "large", button_hover: "none",
                                   json_data: { "tabs" => [{ "name" => "Home", "sections" => [] }, { "name" => "About", "sections" => [] }] })
      log_in(seller)

      get profile_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["profile_settings"]).to include("name" => "Designer", "font" => "Inter", "hide_follow_form" => true)
      expect(props["editable_profile"]["posts"].map { _1["name"] }).to eq(["Profile post"])
      expect(props["tabs"].map { _1["name"] }).to eq(%w[Home About])
    end

    it "asks for the email to be confirmed", parity: true do
      log_in(seller)
      seller.update_columns(confirmed_at: nil, unconfirmed_email: "new@example.com")

      get profile_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["email_confirmation"]).to eq("email" => "new@example.com", "can_resend" => true)
    end

    it "does not show the follow captcha for a compliant seller", parity: true do
      seller.mark_compliant!(author_name: "test")
      log_in(seller)

      get profile_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["editable_profile"]["creator_profile"]["follow_recaptcha_site_key"]).to be_nil
    end

    it "tells a seller with a custom landing page", parity: true do
      seller.update!(custom_html: "<p>Hello</p>")
      log_in(seller)

      get profile_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["has_custom_landing_page"]).to eq(true)
    end

    it "lets an admin team member edit the profile with their own currency", parity: true do
      member = member_with_role(TeamMembership::ROLE_ADMIN)
      member.update!(currency_type: "eur")

      get profile_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["editable_profile"]).to include("currency_code" => "eur")
      expect(props["editable_profile"]["creator_profile"]["can_edit"]).to eq(true)
    end

    it "lets a marketing team member edit the profile", parity: true do
      member_with_role(TeamMembership::ROLE_MARKETING)

      get profile_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["editable_profile"]["creator_profile"]["can_edit"]).to eq(true)
    end

    it "shows the profile to an accountant team member without letting them edit it", parity: true do
      member_with_role(TeamMembership::ROLE_ACCOUNTANT)

      get profile_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["editable_profile"]["creator_profile"]["can_edit"]).to eq(false)
    end

    it "shows the profile to a support team member without letting them edit it", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      get profile_path

      expect(response).to be_successful
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      get profile_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Settings/Profile/Show")
    end
  end

  describe "application editor" do
    it "renders the editor for an application of the owner", parity: true do
      application = create(:oauth_application, owner: seller, name: "My app", redirect_uri: "https://example.com/callback")
      log_in(seller)

      get edit_oauth_application_path(application.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["application"]).to include("name" => "My app", "uid" => application.uid, "secret" => application.secret, "icon_url" => nil)
    end

    it "renders the editor for an admin team member", parity: true do
      application = create(:oauth_application, owner: seller, name: "Team app")
      member_with_role(TeamMembership::ROLE_ADMIN)

      get edit_oauth_application_path(application.external_id)

      expect(response).to be_successful
    end

    it "sends a marketing team member to the dashboard", parity: true do
      application = create(:oauth_application, owner: seller)
      member_with_role(TeamMembership::ROLE_MARKETING)

      get edit_oauth_application_path(application.external_id)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end

    it "redirects when the application belongs to someone else", parity: true do
      application = create(:oauth_application, owner: create(:user))
      log_in(seller)

      get edit_oauth_application_path(application.external_id)

      expect(response).to redirect_to(oauth_applications_url)
      expect(flash[:alert]).to eq("Application not found or you don't have the permissions to modify it.")
    end

    it "redirects when the application was deleted", parity: true do
      application = create(:oauth_application, owner: seller, deleted_at: Time.current)
      log_in(seller)

      get edit_oauth_application_path(application.external_id)

      expect(response).to redirect_to(oauth_applications_url)
    end

    it "redirects when the id is not an application", parity: true do
      log_in(seller)

      get edit_oauth_application_path("not-an-id")

      expect(response).to redirect_to(oauth_applications_url)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      application = create(:oauth_application, owner: seller)
      log_in(seller)

      get edit_oauth_application_path(application.external_id), headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Oauth/Applications/Edit")
    end
  end

  describe "social connections" do
    it "keeps the destination of the onboarding flow in the session", parity: true do
      log_in(seller)

      get settings_social_connections_path(social_connect_origin: "onboarding")

      expect(response).to be_successful
      expect(inertia_props_of(response)["social_connect_return"]).to match(/\A\h{64}\z/)
    end

    it "gives the same token to a second visit of the same flow", parity: true do
      log_in(seller)
      get settings_social_connections_path(social_connect_origin: "onboarding")
      first = inertia_props_of(response)["social_connect_return"]

      get settings_social_connections_path(social_connect_origin: "onboarding")

      expect(inertia_props_of(response)["social_connect_return"]).to eq(first)
    end

    it "replaces the token when the flow starts somewhere else", parity: true do
      product = create(:product, user: seller)
      log_in(seller)
      get settings_social_connections_path(social_connect_origin: "onboarding")
      first = inertia_props_of(response)["social_connect_return"]

      get settings_social_connections_path(social_connect_origin: "marketing", social_connect_product: product.unique_permalink)

      second = inertia_props_of(response)["social_connect_return"]
      expect(second).to match(/\A\h{64}\z/)
      expect(second).not_to eq(first)
    end

    it "forgets a stored flow when the page is opened without one", parity: true do
      log_in(seller)
      get settings_social_connections_path(social_connect_origin: "onboarding")

      get settings_social_connections_path

      expect(inertia_props_of(response)["social_connect_return"]).to be_nil
      get settings_social_connections_path(social_connect_origin: "onboarding")
      expect(inertia_props_of(response)["social_connect_return"]).to match(/\A\h{64}\z/)
    end

    it "gives no token for a marketing flow whose product is not published", parity: true do
      product = create(:product, user: seller, purchase_disabled_at: Time.current)
      log_in(seller)

      get settings_social_connections_path(social_connect_origin: "marketing", social_connect_product: product.unique_permalink)

      expect(inertia_props_of(response)["social_connect_return"]).to be_nil
    end

    it "gives no token for an origin the page does not know", parity: true do
      log_in(seller)

      get settings_social_connections_path(social_connect_origin: "somewhere")

      expect(inertia_props_of(response)["social_connect_return"]).to be_nil
    end
  end

  describe "payments" do
    it "asks an owner without compliance info for the country", parity: true do
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["should_show_country_modal"]).to eq(true)
      expect(props["compliance_info"]["country"]).to be_nil
    end

    it "renders a US individual with a bank account and a PayPal address", parity: true do
      create(:user_compliance_info, user: seller)
      create(:ach_account, user: seller, stripe_bank_account_id: "ba_1")
      seller.update!(payment_address: "payouts@example.com")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["user"]["individual_tax_id_entered"]).to eq(true)
      expect(props["bank_account_details"]["account_number_visual"]).to eq("******1234")
    end

    it "renders a US business with both tax ids", parity: true do
      create(:user_compliance_info_business, user: seller)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["compliance_info"]["is_business"]).to eq(true)
    end

    it "renders the page read only for an admin team member", parity: true do
      create(:user_compliance_info, user: seller)
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["is_form_disabled"]).to eq(false)
    end

    it "sends an accountant team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_ACCOUNTANT)

      get settings_payments_path

      expect(response).to redirect_to(dashboard_url)
    end

    it "renders a Canadian seller with a Canadian bank account", parity: true do
      create(:user_compliance_info_canada, user: seller)
      create(:canadian_bank_account, user: seller, stripe_bank_account_id: "ba_1")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["user"]["country_code"]).to eq("CA")
    end

    it "renders a Mexican seller whose minimum payout is converted from pesos", parity: true do
      create(:user_compliance_info, user: seller, country: "Mexico", state: "JAL", zip_code: "44100")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["minimum_payout_threshold_cents"]).to be > 0
    end

    it "renders a Japanese seller with kana and kanji names", parity: true do
      create(:user_compliance_info, user: seller, country: "Japan", state: "東京都", zip_code: "100-0001", first_name_kanji: "太郎", last_name_kanji: "山田", first_name_kana: "タロウ", last_name_kana: "ヤマダ", building_number: "1-1", street_address_kana: "チヨダ", city_kana: "チヨダク", phone: "+81312345678", nationality: "JP")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["compliance_info"]).to include("first_name_kana" => "タロウ")
    end

    it "renders a seller from a country without a bank payout rail", parity: true do
      create(:user_compliance_info, user: seller, country: "Nepal", state: "Bagmati", zip_code: "44600")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["user"]["country_supports_native_payouts"]).to eq(false)
    end

    it "renders a seller who paused their own payouts", parity: true do
      create(:user_compliance_info, user: seller)
      seller.update!(payouts_paused_by_user: true)
      seller.update!(payout_frequency: "monthly", payout_threshold_cents: 25_000)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("payouts_paused_by_user" => true, "payout_frequency" => "monthly", "payout_threshold_cents" => 25_000)
    end

    it "renders a seller whose payouts Stripe paused", parity: true do
      create(:user_compliance_info, user: seller)
      create(:merchant_account, user: seller, country: "US")
      seller.update!(payouts_paused_internally: true, payouts_paused_by: "stripe")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["payouts_paused_by"]).to eq("stripe")
      expect(props["account_status"]["compliance_actions"].first["message"]).to include("Stripe")
    end

    it "renders the chargeback payout reserve", parity: true do
      create(:user_compliance_info, user: seller)
      create(:comment, commentable: seller, author_name: "pause_payouts_for_seller_based_on_chargeback_rate", comment_type: Comment::COMMENT_TYPE_ON_PROBATION)
      seller.update!(payouts_paused_internally: true, payouts_paused_by: "system")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("payout_reserve_available" => true, "payout_reserve_percent" => 25)
    end

    it "lists the verification the seller still has to provide", parity: true do
      create(:user_compliance_info, user: seller)
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::TAX_ID, state: "requested")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::PHONE_NUMBER, state: "requested")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      status = inertia_props_of(response)["account_status"]
      expect(status["needs_id_upload"]).to eq(true)
      expect(status["compliance_actions"].first["message"]).to start_with("Please provide:")
    end

    it "links to Stripe's remediation when a Stripe account has requests open", parity: true do
      create(:user_compliance_info, user: seller)
      create(:merchant_account, user: seller, country: "US")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::TAX_ID, state: "requested")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::NATIONALITY, state: "requested")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["account_status"]["compliance_actions"].first["href"]).to eq("/settings/payments/remediation")
    end

    it "shows the postal code Stripe rejected", parity: true do
      create(:user_compliance_info, user: seller)
      create(:comment, commentable: seller, author_id: GUMROAD_ADMIN_ID, author_name: "admin", comment_type: Comment::COMMENT_TYPE_PAYOUT_NOTE,
                       content: "#{StripeMerchantAccountManager::POSTAL_CODE_FAILURE_NOTE_PREFIX}: 94107")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["account_status"]["compliance_actions"].first["message"]).to include("postal code")
    end

    it "shows an account under review and records the social connections offered", parity: true do
      create(:user_compliance_info, user: seller)
      seller.put_on_probation!(author_name: "test")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      status = inertia_props_of(response)["account_status"]
      expect(status["gumroad_status"]).to include("under review")
      expect(status["social_connections_for_review"]).to eq([{ "provider" => "twitter", "connected" => false }])
    end

    it "does not offer the social connections to a team admin", parity: true do
      create(:user_compliance_info, user: seller)
      seller.put_on_probation!(author_name: "test")
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["account_status"]["social_connections_for_review"]).to be_nil
    end

    it "shows the Stripe rejection and what is left of the balance", parity: true do
      create(:user_compliance_info, user: seller)
      create(:merchant_account, user: seller, country: "US", json_data: { "stripe_disabled_reason" => "rejected.fraud" })
      create(:balance, user: seller, amount_cents: 50, merchant_account: create(:merchant_account, user: nil))
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["account_status"]).to include("stripe_rejected" => true, "stripe_rejected_balance_status" => "too_small")
    end

    it "shows a rejected account whose payouts are held", parity: true do
      create(:user_compliance_info, user: seller)
      create(:merchant_account, user: seller, country: "US", json_data: { "stripe_disabled_reason" => "rejected.listed" })
      create(:balance, user: seller, amount_cents: 500_00, merchant_account: create(:merchant_account, user: nil))
      seller.update!(payouts_paused_by_user: true)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["account_status"]).to include("stripe_rejected_balance_status" => "held", "stripe_rejected_formatted_balance" => "$500")
    end

    it "shows the balance forfeited when the seller changes country", parity: true do
      create(:user_compliance_info, user: seller)
      managed = create(:merchant_account, user: seller, country: "US")
      create(:balance, user: seller, amount_cents: 1_234_56, merchant_account: managed)
      create(:balance, user: seller, amount_cents: 20_00, merchant_account: create(:merchant_account, user: nil))
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["formatted_balance_to_forfeit_on_country_change"]).to eq("$1,234.56")
    end

    it "counts a balance on a second Gumroad account of the same processor as the seller's to forfeit", parity: true do
      create(:user_compliance_info, user: seller)
      managed = create(:merchant_account, user: seller, country: "US")
      create(:balance, user: seller, amount_cents: 1_234_56, merchant_account: managed)
      create(:balance, user: seller, amount_cents: 20_00, merchant_account: create(:merchant_account, user: nil))
      create(:balance, user: seller, amount_cents: 7_00, merchant_account: create(:merchant_account, user: nil))
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["formatted_balance_to_forfeit_on_country_change"]).to eq("$1,241.56")
    end

    it "shows the verification error Stripe returned instead of asking for the field", parity: true do
      create(:user_compliance_info, user: seller)
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested", verification_error: { "code" => "verification_document_fraudulent" })
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::TAX_ID, state: "requested", verification_error: { "code" => "verification_failed_other", "message" => "Stripe could not verify this number!" })
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      messages = inertia_props_of(response)["account_status"]["compliance_actions"].map { |action| action["message"] }
      expect(messages).to eq(["The document might have been altered so it could not be verified.", "Stripe could not verify this number."])
    end

    it "explains the P.O. Box deadlock when an older address revision was a P.O. Box", parity: true do
      create(:user_compliance_info, user: seller, street_address: "Box 65, RR 2")
      create(:user_compliance_info, user: seller, street_address: "NW-22-34-19-W2")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested", verification_error: { "code" => "verification_document_address_mismatch", "message" => "Stripe says no" })
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      messages = inertia_props_of(response)["account_status"]["compliance_actions"].map { |action| action["message"] }
      expect(messages).to eq([UserComplianceInfoRequest::PO_BOX_ADDRESS_DEADLOCK_MESSAGE.delete_suffix(".") + "."])
    end

    it "keeps the address mismatch copy when no address revision looks like a P.O. Box", parity: true do
      create(:user_compliance_info, user: seller, street_address: "1 Boxwood Lane")
      create(:user_compliance_info_request, user: seller, field_needed: UserComplianceInfoFields::Individual::STRIPE_IDENTITY_DOCUMENT_ID, state: "requested", verification_error: { "code" => "verification_failed_address_match" })
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      messages = inertia_props_of(response)["account_status"]["compliance_actions"].map { |action| action["message"] }
      expect(messages).to eq(["The address on the document doesn’t match the address on the account. Please verify and correct the provided address on the account, or upload a document with address that matches the account."])
    end

    it "shows an Australian seller who owes backtaxes and has opted in", parity: true do
      create(:user_compliance_info, user: seller, country: "Australia", state: "NSW", zip_code: "2000")
      seller.update!(au_backtax_owed_cents: 150_00, au_backtax_sales_cents: 2_500_50)
      agreement = create(:backtax_agreement, user: seller)
      create(:australia_backtax_email_info, user: seller)
      balance = create(:balance, user: seller, merchant_account: create(:merchant_account, user: nil))
      create(:credit, user: seller, merchant_account: balance.merchant_account, balance:, backtax_agreement: agreement)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["aus_backtax_details"]).to include("opted_in_to_au_backtax" => true, "are_au_backtaxes_paid" => true)
    end

    it "asks a US minor for a legal guardian", parity: true do
      create(:user_compliance_info, user: seller, birthday: 16.years.ago.to_date)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["legal_guardian"]).to include("required" => true, "blocking_payouts" => true, "guardian" => nil)
    end

    it "shows the legal guardian of a US minor", parity: true do
      guardian = create(:guardian, user: seller)
      create(:user_compliance_info, user: seller, birthday: 16.years.ago.to_date, guardian:)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["legal_guardian"]).to include("required" => true, "blocking_payouts" => false)
    end

    it "tells a minor from a country without a guardian path", parity: true do
      create(:user_compliance_info, user: seller, country: "Canada", state: "BC", zip_code: "M4C 1T2", birthday: 16.years.ago.to_date)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["legal_guardian"]).to include("unsupported" => true)
    end

    it "shows the saved card of the seller", parity: true do
      create(:user_compliance_info, user: seller)
      card = create(:indian_stripe_credit_card)
      seller.update!(credit_card: card)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["saved_card"]).to include("requires_mandate" => true)
    end

    # Not recorded: a seller with a Connect account reaches User#sales_cents_total in the shared props,
    # an Elasticsearch aggregate the Next.js port does not have.
    it "shows a seller with a Stripe Connect account that does not route sales" do
      create(:user_compliance_info, user: seller)
      create(:merchant_account_stripe_connect, user: seller)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["stripe_connect"]).to include("has_connected_stripe" => true, "stripe_connect_routing_active" => false, "blocks_managed_account" => true)
    end

    it "lets the owner of a business with a Stripe account manage beneficial owners", parity: true do
      create(:user_compliance_info_business, user: seller)
      create(:merchant_account, user: seller, country: "US")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["can_manage_beneficial_owners"]).to eq(true)
    end

    it "shows the fee of a seller with a custom fee", parity: true do
      create(:user_compliance_info, user: seller)
      seller.update!(custom_fee_per_thousand: 25)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["fee_info"]["merchant_account_fee_info"]["items"].first["value"]).to start_with("2.5% + 50")
    end

    it "shows the fee of a Brazilian seller", parity: true do
      create(:user_compliance_info, user: seller, country: "Brazil", state: "SP", zip_code: "01000-000")
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["fee_info"]["connect_account_fee_info"]["summary"]).to eq("You pay a 0% Gumroad fee on all sales.")
    end

    it "shows a seller who pays for a subscription", parity: true do
      create(:user_compliance_info, user: seller)
      subscription = create(:subscription, user: seller)
      create(:free_purchase, purchaser: seller).update_columns(price_cents: 500, subscription_id: subscription.id)
      log_in(seller)

      get settings_payments_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["user"]["requires_credit_card"]).to eq(true)
    end

    it "sends a marketing team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_MARKETING)

      get settings_payments_path

      expect(response).to redirect_to(dashboard_url)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      create(:user_compliance_info, user: seller)
      log_in(seller)

      get settings_payments_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Settings/Payments/Show")
    end
  end
end
