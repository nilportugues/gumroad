# frozen_string_literal: true

require "spec_helper"

# Settings::MainController#update and #resend_confirmation_email the way the Inertia form sends them (JSON body, X-Inertia, the CSRF
# token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-main.replay.test.ts, which sends the last request of each example. Node serves the saves that send no
# mail; a new or pending email address, a username change, a refund policy the fine print classifier must read, a missing user hash and
# the resend of a confirmation email are handed to Rails ("hands a ..." examples).
describe "Settings main when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Main Seller", username: "settingsmain", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings" }
  end
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_form(method, path, body, headers: inertia_headers)
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: headers.merge("X-CSRF-Token" => token))
  end

  def member_with_role(role)
    member = create(:user, name: "Team Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def settings(**user)
    { user: { email: seller.email, username: "settingsmain", enable_payment_email: true, enable_payment_push_notification: true,
              enable_recurring_subscription_charge_email: true, enable_recurring_subscription_charge_push_notification: true,
              enable_free_downloads_email: true, enable_free_downloads_push_notification: true, announcement_notification_enabled: true,
              disable_comments_email: false, disable_reviews_email: false, disable_review_reminders: false, support_email: "",
              locale: "en", timezone: "Pacific Time (US & Canada)", currency_type: "usd", purchasing_power_parity_enabled: false,
              purchasing_power_parity_limit: nil, purchasing_power_parity_payment_verification_disabled: false, show_nsfw_products: false,
              disable_affiliate_requests: false, purchasing_power_parity_excluded_product_ids: [], product_level_support_emails: [],
              seller_refund_policy: { max_refund_period_in_days: 30, fine_print: "" } }.merge(user) }
  end

  describe "update" do
    it "saves the switches, the locale, the time zone and the currency", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(enable_payment_email: false, disable_comments_email: true, locale: "fr", timezone: "UTC", currency_type: "eur",
                                                   support_email: " help@example.com ", show_nsfw_products: true))

      expect(response).to redirect_to(settings_main_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Your account has been updated!")
      expect(seller.reload).to have_attributes(enable_payment_email: false, disable_comments_email: true, locale: "fr", timezone: "UTC", currency_type: "eur",
                                               support_email: "help@example.com", show_nsfw_products: true)
    end

    it "accepts PATCH", parity: true do
      log_in(seller)

      send_form(:patch, settings_main_path, settings(show_nsfw_products: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.show_nsfw_products).to eq(true)
    end

    it "casts the purchasing power parity limit sent as text", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: "40"))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: 40)
    end

    it "truncates a fractional purchasing power parity limit like an integer column", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_limit: 12.5))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.purchasing_power_parity_limit).to eq(12)
    end

    it "casts a whole-number float purchasing power parity limit", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_limit: 40.0))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.purchasing_power_parity_limit).to eq(40)
    end

    it "reads the float 1.0 as a set flag and any other float as unset", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(show_nsfw_products: 1.0, enable_payment_email: 0.5, disable_comments_email: 0.0))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(show_nsfw_products: true, enable_payment_email: false, disable_comments_email: false)
    end

    it "answers an integer support email past 2**53 with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(support_email: 12345678901234567890, show_nsfw_products: true))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Support email")
    end

    it "refuses a purchasing power parity limit past 2**53 with the range error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_limit: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Purchasing power parity limit must be less than or equal to 100")
      expect(seller.reload.purchasing_power_parity_limit).to be_nil
    end

    it "refuses a purchasing power parity limit below -2**53 with the range error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_limit: -12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Purchasing power parity limit must be greater than or equal to 1")
      expect(seller.reload.purchasing_power_parity_limit).to be_nil
    end

    it "reads an integer feature announcements flag past 2**53 as subscribed", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(feature_announcements_subscribed: 12345678901234567890, feature_announcements_version: 0))

      expect(response).to have_http_status(:see_other)
      expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 1)
    end

    it "answers a float support email with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(support_email: 12.5, show_nsfw_products: true))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Support email")
      expect(seller.reload.show_nsfw_products).to eq(false)
    end

    it "answers a float timezone with the unknown time zone error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(timezone: 5.0))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Timezone")
    end

    it "answers the purchasing power parity limit out of range with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_limit: 101, enable_payment_email: false))

      expect(response).to redirect_to(settings_main_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Purchasing power parity limit")
      expect(seller.reload.enable_payment_email).to eq(true)
    end

    it "answers an invalid support email with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(support_email: "not-an-email"))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Support email")
      expect(seller.reload.support_email).to be_blank
    end

    it "answers an unknown time zone with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_main_path, settings(timezone: "Mars"))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Mars is not a known time zone.")
    end

    it "excludes the products listed from purchasing power parity and includes the rest again", parity: true do
      kept = create(:product, user: seller, name: "Excluded now", unique_permalink: "pppnow", created_at: Time.utc(2025, 1, 2))
      lifted = create(:product, user: seller, name: "Excluded before", unique_permalink: "pppbefore", created_at: Time.utc(2025, 1, 3))
      lifted.purchasing_power_parity_disabled = true
      lifted.save!(validate: false)
      log_in(seller)

      send_form(:put, settings_main_path, settings(purchasing_power_parity_excluded_product_ids: [kept.external_id]))

      expect(response).to have_http_status(:see_other)
      expect(kept.reload.purchasing_power_parity_disabled).to eq(true)
      expect(lifted.reload.purchasing_power_parity_disabled).to eq(false)
    end

    it "sets the product-level support emails and clears the ones left out", parity: true do
      first = create(:product, user: seller, name: "First", unique_permalink: "supfirst", created_at: Time.utc(2025, 1, 2))
      second = create(:product, user: seller, name: "Second", unique_permalink: "supsecond", created_at: Time.utc(2025, 1, 3))
      first.update_column(:support_email, "old@example.com")
      log_in(seller)

      send_form(:put, settings_main_path, settings(product_level_support_emails: [{ email: "help@example.com", product_ids: [second.external_id] },
                                                                                  { email: "", product_ids: [first.external_id] }]))

      expect(response).to have_http_status(:see_other)
      expect(first.reload.support_email).to be_nil
      expect(second.reload.support_email).to eq("help@example.com")
    end

    it "keeps the saved settings and answers the generic failure for a reserved product-level support email", parity: true do
      product = create(:product, user: seller, name: "Reserved", unique_permalink: "supreserved", created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      send_form(:put, settings_main_path, settings(show_nsfw_products: true, product_level_support_emails: [{ email: "support@gumroad.com", product_ids: [product.external_id] }]))

      expect(response).to redirect_to(settings_main_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
      expect(seller.reload.show_nsfw_products).to eq(true)
      expect(product.reload.support_email).to be_nil
    end

    describe "feature announcements" do
      def announcements(subscribed, version) = settings(feature_announcements_subscribed: subscribed, feature_announcements_version: version)

      it "subscribes when no row exists", parity: true do
        log_in(seller)

        send_form(:put, settings_main_path, announcements(true, 0))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated!")
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 1, source: "settings")
      end

      it "unsubscribes and moves the version on", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: true, source: "settings", version: 3)
        log_in(seller)

        send_form(:put, settings_main_path, announcements("false", "3"))

        expect(response).to have_http_status(:see_other)
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: false, version: 4, source: "settings")
      end

      it "leaves a subscription alone when the form agrees with it", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: true, source: "newsletter_migration", version: 2)
        log_in(seller)

        send_form(:put, settings_main_path, announcements(true, 2))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated!")
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(version: 2, source: "newsletter_migration")
      end

      it "says the subscription changed when the version is an integer past 2**53", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: true, source: "settings", version: 3)
        log_in(seller)

        send_form(:put, settings_main_path, announcements(false, 12345678901234567890))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated, but Feature announcements changed elsewhere, so that setting was not saved.")
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 3)
      end

      it "leaves a subscription alone when the form agrees with it and the version is past 2**53", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: true, source: "settings", version: 3)
        log_in(seller)

        send_form(:put, settings_main_path, announcements(true, 12345678901234567890))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated!")
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 3)
      end

      it "reads a float version as unknown and says the subscription changed", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: true, source: "settings", version: 3)
        log_in(seller)

        send_form(:put, settings_main_path, announcements(false, 3.0))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated, but Feature announcements changed elsewhere, so that setting was not saved.")
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 3)
      end

      it "reads a 0.0 subscription flag as subscribed because Boolean casts only the integer 0 to false", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: false, source: "settings", version: 3)
        log_in(seller)

        send_form(:put, settings_main_path, announcements(0.0, 3))

        expect(response).to have_http_status(:see_other)
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: true, version: 4)
      end

      it "saves the rest and says so when the subscription changed since the form rendered", parity: true do
        FeatureAnnouncementSubscription.create!(user_id: seller.id, subscribed: false, source: "unsubscribe_link", version: 2)
        log_in(seller)

        send_form(:put, settings_main_path, settings(show_nsfw_products: true, feature_announcements_subscribed: true, feature_announcements_version: 1))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated, but Feature announcements changed elsewhere, so that setting was not saved.")
        expect(seller.reload.show_nsfw_products).to eq(true)
        expect(FeatureAnnouncementSubscription.find_by!(user_id: seller.id)).to have_attributes(subscribed: false, version: 2)
      end
    end

    describe "account-level refund policy" do
      let(:refund_policy_params) { { max_refund_period_in_days: 14, fine_print: "" } }

      it "updates the policy when the seller can edit it", parity: true do
        seller.update!(refund_policy_enabled: true)
        log_in(seller)

        send_form(:put, settings_main_path, settings(seller_refund_policy: refund_policy_params))

        expect(response).to have_http_status(:see_other)
        expect(seller.refund_policy.reload).to have_attributes(max_refund_period_in_days: 14, fine_print: nil)
      end

      it "truncates a fractional refund period like an integer column", parity: true do
        seller.update!(refund_policy_enabled: true)
        log_in(seller)

        send_form(:put, settings_main_path, settings(seller_refund_policy: { max_refund_period_in_days: 14.5, fine_print: "" }))

        expect(response).to have_http_status(:see_other)
        expect(seller.refund_policy.reload).to have_attributes(max_refund_period_in_days: 14, fine_print: nil)
      end

      it "stores the text of a float fine print", parity: true do
        seller.update!(refund_policy_enabled: true)
        log_in(seller)

        send_form(:put, settings_main_path, settings(seller_refund_policy: { max_refund_period_in_days: 0, fine_print: 1.5 }))

        expect(response).to have_http_status(:see_other)
        expect(seller.refund_policy.reload.fine_print).to eq("1.5")
      end

      it "answers a refund period outside the allowed list with the policy's validation error", parity: true do
        seller.update!(refund_policy_enabled: true)
        log_in(seller)

        send_form(:put, settings_main_path, settings(show_nsfw_products: true, seller_refund_policy: { max_refund_period_in_days: 5 }))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to include("Max refund period in days")
        expect(seller.reload.show_nsfw_products).to eq(true)
        expect(seller.refund_policy.reload.max_refund_period_in_days).to eq(30)
      end

      it "ignores the policy when the seller cannot edit it", parity: true do
        seller.update!(refund_policy_enabled: false)
        log_in(seller)

        send_form(:put, settings_main_path, settings(seller_refund_policy: refund_policy_params))

        expect(response).to have_http_status(:see_other)
        expect(seller.refund_policy.reload.max_refund_period_in_days).to eq(30)
      end

      it "hands a fine print the classifier must read to Rails", parity: true do
        allow_any_instance_of(RefundPolicy).to receive(:fine_print_claims_no_refunds?).and_return(false)
        seller.update!(refund_policy_enabled: true)
        log_in(seller)

        send_form(:put, settings_main_path, settings(seller_refund_policy: { max_refund_period_in_days: 30, fine_print: "Ask nicely and we will refund." }))

        expect(response).to have_http_status(:see_other)
        expect(seller.refund_policy.reload.fine_print).to eq("Ask nicely and we will refund.")
      end
    end

    describe "who may save" do
      it "sends an admin to the dashboard", parity: true do
        member_with_role(TeamMembership::ROLE_ADMIN)

        send_form(:put, settings_main_path, settings(show_nsfw_products: true))

        expect(response).to redirect_to(dashboard_url(host: DOMAIN))
        expect(flash[:alert]).to eq("Your current role as Admin cannot perform this action.")
        expect(seller.reload.show_nsfw_products).to eq(false)
      end
    end

    describe "requests handed to Rails" do
      it "hands a new email address to Rails", parity: true do
        log_in(seller)

        send_form(:put, settings_main_path, settings(email: "new-address@example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.unconfirmed_email).to eq("new-address@example.com")
      end

      it "hands a username change to Rails", parity: true do
        log_in(seller)

        send_form(:put, settings_main_path, settings(username: "renamedmain"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.username).to eq("renamedmain")
      end

      it "hands a seller with an email change awaiting confirmation to Rails", parity: true do
        log_in(seller)
        seller.update_columns(unconfirmed_email: "pending@example.com")

        send_form(:put, settings_main_path, settings)

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.unconfirmed_email).to be_nil
      end

      it "hands a request without a user hash to Rails", parity: true do
        log_in(seller)

        send_form(:put, settings_main_path, {})

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
      end
    end
  end

  describe "resend confirmation email" do
    it "acknowledges a confirmed seller with a JSON failure", parity: true do
      log_in(seller)

      send_form(:post, resend_confirmation_email_settings_main_path, {}, headers: json_headers)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false)
    end

    it "sends a confirmed seller back to the settings with an alert", parity: true do
      log_in(seller)

      send_form(:post, resend_confirmation_email_settings_main_path, {})

      expect(response).to redirect_to(settings_main_path)
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
    end

    it "answers 401 JSON to an admin", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      send_form(:post, resend_confirmation_email_settings_main_path, {}, headers: json_headers)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Admin cannot perform this action.")
    end

    it "hands a resend for an unconfirmed seller to Rails", parity: true do
      log_in(seller)
      seller.update_columns(confirmed_at: nil)

      send_form(:post, resend_confirmation_email_settings_main_path, {}, headers: json_headers)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
    end

    it "hands a resend for a seller with an email change awaiting confirmation to Rails", parity: true do
      log_in(seller)
      seller.update_columns(unconfirmed_email: "pending@example.com")

      send_form(:post, resend_confirmation_email_settings_main_path, {})

      expect(response).to redirect_to(settings_main_path)
      expect(flash[:notice]).to eq("Confirmation email resent!")
    end
  end
end
