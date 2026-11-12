# frozen_string_literal: true

require "spec_helper"

# Saving the third-party analytics and advanced settings the way the Inertia forms do (JSON body, X-Inertia, the CSRF token in
# a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-mutations.replay.test.ts, which sends the last request of each example.
describe "Settings mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Settings Seller", username: "settingsmut", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings" }
  end

  before { host! DOMAIN }

  def send_form(method, path, body)
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def member_with_role(role)
    member = create(:user, name: "Team Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def analytics(**user)
    { user: { disable_third_party_analytics: false, google_analytics_id: "", facebook_pixel_id: "", tiktok_pixel_id: "", skip_free_sale_analytics: false,
              enable_verify_domain_third_party_services: false, facebook_meta_tag: "", snippets: [] }.merge(user) }
  end

  describe "third-party analytics" do
    it "saves the pixel ids and the switches", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(google_analytics_id: "G-ABC123", facebook_pixel_id: " 12345 ", tiktok_pixel_id: "ABC123", skip_free_sale_analytics: true,
                                                                      enable_verify_domain_third_party_services: true, facebook_meta_tag: "<meta name='facebook-domain-verification' content='abc' />"))

      expect(response).to redirect_to(settings_third_party_analytics_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.reload).to have_attributes(google_analytics_id: "G-ABC123", facebook_pixel_id: "12345", tiktok_pixel_id: "ABC123", skip_free_sale_analytics: true)
    end

    it "answers a numeric TikTok pixel id with the generic failure and saves nothing", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(tiktok_pixel_id: 1234567890, google_analytics_id: "G-NOTSAVED"))

      expect(response).to redirect_to(settings_third_party_analytics_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
      expect(seller.reload).to have_attributes(google_analytics_id: nil, tiktok_pixel_id: nil)
    end

    it "casts a boolean Facebook pixel id to 1 like a varchar column", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(facebook_pixel_id: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.facebook_pixel_id).to eq("1")
    end

    it "answers a float TikTok pixel id with the generic failure and saves nothing", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(tiktok_pixel_id: 1234.5, google_analytics_id: "G-NOTSAVED"))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
      expect(seller.reload).to have_attributes(google_analytics_id: nil, tiktok_pixel_id: nil)
    end

    it "answers a whole-number float TikTok pixel id with the generic failure", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(tiktok_pixel_id: 1234567890.0))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
    end

    it "answers a fractional Facebook pixel id with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(facebook_pixel_id: 12345.5))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Facebook")
      expect(seller.reload.facebook_pixel_id).to be_nil
    end

    it "keeps the point of a whole-number float Facebook pixel id", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(facebook_pixel_id: 12345.0))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.facebook_pixel_id).to be_nil
    end

    it "reads the float 1.0 as a set switch and any other float as unset", parity: true do
      seller.update!(skip_free_sale_analytics: true)
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(disable_third_party_analytics: 1.0, skip_free_sale_analytics: 0.5))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(disable_third_party_analytics: true, skip_free_sale_analytics: false)
    end

    it "hands a float snippet field to Rails", parity: true do
      create(:product, user: seller)
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: nil, name: 1.5, location: "receipt", code: "<script>1</script>", product: nil }]))

      expect(response).to have_http_status(:see_other)
    end

    it "answers a float Google Analytics id with its validation error", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(google_analytics_id: 1.5))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Google Analytics")
    end

    it "accepts PATCH", parity: true do
      log_in(seller)

      send_form(:patch, settings_third_party_analytics_path, analytics(disable_third_party_analytics: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.disable_third_party_analytics).to eq(true)
    end

    it "creates snippets for every product and for one product", parity: true do
      product = create(:product, user: seller, name: "Analytics product", unique_permalink: "anaprod", created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                      { id: nil, name: "Everywhere", location: "all", product: "#all_products", code: "<script>all()</script>" },
                                                                      { id: nil, name: "One product", location: "receipt", product: product.unique_permalink, code: "<script>one()</script>" },
                                                                    ]))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.pluck(:name)).to match_array(["Everywhere", "One product"])
    end

    it "casts integer snippet fields and looks an integer permalink up as a string", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                      { id: nil, name: 7, location: "product", product: 4242, code: 1234 },
                                                                    ]))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole).to have_attributes(name: "7", link_id: nil, analytics_code: "1234")
    end

    it "casts a boolean snippet name and code on update", parity: true do
      kept = create(:third_party_analytic, user: seller, link: nil, name: "Kept", location: "all", analytics_code: "<script>old()</script>")
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: kept.external_id, name: true, location: "all", product: "#all_products", code: false }]))

      expect(response).to have_http_status(:see_other)
      expect(kept.reload).to have_attributes(name: "1", analytics_code: "f")
    end

    it "updates a snippet and deletes the ones left out", parity: true do
      kept = create(:third_party_analytic, user: seller, link: nil, name: "Kept", location: "all", analytics_code: "<script>old()</script>")
      create(:third_party_analytic, user: seller, link: nil, name: "Dropped", location: "receipt")
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: kept.external_id, name: "Renamed", location: "product", product: "#all_products", code: "<script>new()</script>" }]))

      expect(response).to have_http_status(:see_other)
      expect(kept.reload).to have_attributes(name: "Renamed", location: "product", analytics_code: "<script>new()</script>")
      expect(seller.third_party_analytics.alive.count).to eq(1)
    end

    it "deletes every snippet when none is sent", parity: true do
      create(:third_party_analytic, user: seller, link: nil, name: "Only one")
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics)

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.count).to eq(0)
    end

    it "refuses two blocks for the same place", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                      { id: nil, name: "One", location: "all", product: "#all_products", code: "<script>1()</script>" },
                                                                      { id: nil, name: "Two", location: "all", product: "#all_products", code: "<script>2()</script>" },
                                                                    ]))

      expect(response).to redirect_to(settings_third_party_analytics_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to start_with("Only one analytics block is allowed per product.")
      expect(seller.third_party_analytics.count).to eq(0)
    end

    it "answers with the validation error of an invalid Google Analytics id", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(google_analytics_id: "UA-123"))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Please enter a valid Google Analytics ID")
      expect(seller.reload.google_analytics_id).to be_blank
    end

    it "answers with the validation errors of invalid pixel ids and a long meta tag", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(facebook_pixel_id: "abc", tiktok_pixel_id: "lower", facebook_meta_tag: "x" * 101))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Please enter a valid Facebook Pixel ID")
    end

    it "lets an admin save", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      send_form(:put, settings_third_party_analytics_path, analytics(google_analytics_id: "G-ADMIN1"))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.google_analytics_id).to eq("G-ADMIN1")
    end

    it "sends a marketing member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_MARKETING)

      send_form(:put, settings_third_party_analytics_path, analytics(google_analytics_id: "G-NOPE"))

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
      expect(seller.reload.google_analytics_id).to be_blank
    end
  end

  describe "advanced" do
    def advanced(domain: nil, emails: nil, endpoint: "")
      { domain:, blocked_customer_emails: emails, user: { notification_endpoint: endpoint } }.compact
    end

    it "saves the ping endpoint and prefixes a missing scheme", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(endpoint: "example.com/ping"))

      expect(response).to redirect_to(settings_advanced_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Your account has been updated!")
      expect(seller.reload.notification_endpoint).to eq("http://example.com/ping")
    end

    it "casts a boolean ping endpoint like a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(endpoint: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.notification_endpoint).to eq("http://t")
    end

    it "casts a float ping endpoint like a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(endpoint: 12.5))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.notification_endpoint).to eq("http://12.5")
    end

    it "casts a whole-number float ping endpoint like a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(endpoint: 7.0))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.notification_endpoint).to eq("http://7.0")
    end

    it "accepts PATCH", parity: true do
      log_in(seller)

      send_form(:patch, settings_advanced_path, advanced(endpoint: "https://example.com/hook"))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.notification_endpoint).to eq("https://example.com/hook")
    end

    it "blocks the emails listed", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(emails: "one@example.com\ntwo@example.com\r\nthree@example.com"))

      expect(response).to have_http_status(:see_other)
      expect(seller.blocked_customer_objects.active.email.pluck(:object_value)).to match_array(%w[one@example.com two@example.com three@example.com])
    end

    it "unblocks the emails left out of the list", parity: true do
      BlockedCustomerObject.block_email!(email: "old@example.com", seller_id: seller.id)
      BlockedCustomerObject.block_email!(email: "keep@example.com", seller_id: seller.id)
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(emails: "keep@example.com\nnew@example.com"))

      expect(response).to have_http_status(:see_other)
      expect(seller.blocked_customer_objects.active.email.pluck(:object_value)).to match_array(%w[keep@example.com new@example.com])
    end

    it "unblocks everything when the list is empty", parity: true do
      BlockedCustomerObject.block_email!(email: "old@example.com", seller_id: seller.id)
      BlockedCustomerObject.block_email!(email: "other@example.com", seller_id: seller.id)
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(emails: ""))

      expect(response).to have_http_status(:see_other)
      expect(seller.blocked_customer_objects.active.count).to eq(0)
    end

    it "refuses an invalid email in the list", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(emails: "good@example.com\nnot-an-email"))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("The email not-an-email cannot be blocked as it is invalid.")
      expect(seller.blocked_customer_objects.count).to eq(0)
    end

    it "removes the custom domain when it is cleared", parity: true do
      create(:custom_domain, user: seller, domain: "shop.example.com")
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(domain: ""))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.custom_domain).to be_nil
    end

    it "hands a new custom domain to Rails, which verifies it over DNS", parity: true do
      allow_any_instance_of(CustomDomain).to receive(:verify)
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(domain: "store.example.com"))

      expect(response).to have_http_status(:see_other)
    end

    it "lets an admin save", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      send_form(:put, settings_advanced_path, advanced(endpoint: "https://example.com/admin"))

      expect(response).to have_http_status(:see_other)
    end

    it "sends a support member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      send_form(:put, settings_advanced_path, advanced(endpoint: "https://example.com/nope"))

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end
  end

  describe "billing details" do
    def billing(**detail)
      { billing_detail: { full_name: "Alice GmbH", business_name: "Acme GmbH", business_id: "DE123456789", street_address: "1 Unter den Linden",
                           city: "Berlin", state: "", zip_code: "10115", country_code: "DE", additional_notes: "", auto_email_invoice_enabled: true }.merge(detail) }
    end

    it "saves a new billing detail", parity: true do
      log_in(seller)

      send_form(:put, settings_billing_path, billing)

      expect(response).to redirect_to(settings_billing_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Your billing details have been saved.")
      expect(seller.reload.billing_detail).to have_attributes(full_name: "Alice GmbH", business_id: "DE123456789", country_code: "DE")
    end

    it "updates the billing detail the seller already has", parity: true do
      create(:billing_detail, purchaser: seller, full_name: "Old Name", country_code: "DE")
      log_in(seller)

      send_form(:patch, settings_billing_path, billing(full_name: "New Name", auto_email_invoice_enabled: false))

      expect(response).to have_http_status(:see_other)
      expect(BillingDetail.where(purchaser_id: seller.id).count).to eq(1)
      expect(seller.reload.billing_detail).to have_attributes(full_name: "New Name", auto_email_invoice_enabled: false)
    end

    it "casts boolean values like a varchar column and a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_billing_path, billing(business_name: true, business_id: false, additional_notes: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.billing_detail).to have_attributes(business_name: "1", business_id: "0", additional_notes: "t")
    end

    it "casts float values like a varchar column and a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_billing_path, billing(business_name: 12.5, business_id: 7.0, additional_notes: 0.25))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.billing_detail).to have_attributes(business_name: "12.5", business_id: "7.0", additional_notes: "0.25")
    end

    it "reads a 0.0 invoice switch as true because Boolean casts only the integer 0 to false", parity: true do
      create(:billing_detail, purchaser: seller, auto_email_invoice_enabled: false)
      log_in(seller)

      send_form(:put, settings_billing_path, billing(auto_email_invoice_enabled: 0.0))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.billing_detail.auto_email_invoice_enabled).to eq(true)
    end

    it "refuses a US address without a state and keeps the errors for the form", parity: true do
      log_in(seller)

      send_form(:put, settings_billing_path, billing(country_code: "US", state: ""))

      expect(response).to redirect_to(settings_billing_path)
      expect(response).to have_http_status(:see_other)
      expect(seller.reload.billing_detail).to be_nil
    end
  end

  describe "JSON actions of the settings pages", elasticsearch_wait_for_refresh: true do
    let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

    before { Purchase.__elasticsearch__.create_index!(force: true) }

    def send_json(method, path, body = nil)
      public_send(method, path, params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
    end

    describe "dismissing the AI product generation promo" do
      # eligible_for_ai_product_generation?: confirmed, not suspended, enough sales and a completed payout.
      def make_eligible
        create(:payment_completed, user: seller)
        build(:purchase, link: create(:product, user: seller, unique_permalink: "aipromo"), seller:, price_cents: 15_000, purchase_state: "successful").save!(validate: false)
        index_model_records(Purchase)
      end

      it "marks the promo as dismissed for an eligible seller", parity: true do
        make_eligible
        log_in(seller)

        send_json(:post, settings_dismiss_ai_product_generation_promo_path)

        expect(response).to have_http_status(:ok)
        expect(seller.reload.dismissed_create_products_with_ai_promo_alert).to be(true)
      end

      it "answers 200 when the promo is already dismissed", parity: true do
        make_eligible
        seller.update!(dismissed_create_products_with_ai_promo_alert: true)
        log_in(seller)

        send_json(:post, settings_dismiss_ai_product_generation_promo_path)

        expect(response).to have_http_status(:ok)
      end

      it "refuses a seller who is not eligible", parity: true do
        log_in(seller)

        send_json(:post, settings_dismiss_ai_product_generation_promo_path)

        expect(response).to have_http_status(:unauthorized)
        expect(seller.reload.dismissed_create_products_with_ai_promo_alert).to be(false)
      end

      it "answers 403 JSON to a seller without an email address", parity: true do
        log_in(seller)
        seller.update_columns(email: nil, unconfirmed_email: nil)

        send_json(:post, settings_dismiss_ai_product_generation_promo_path)

        expect(response).to have_http_status(:forbidden)
      end
    end

    describe "team members" do
      let(:member) { create(:user, name: "Team Member", email: "member@example.com") }
      let!(:membership) { create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING) }

      it "changes the role of a member", parity: true do
        log_in(seller)

        send_json(:put, settings_team_member_path(membership.external_id, format: :json), team_membership: { role: TeamMembership::ROLE_ADMIN })

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.role).to eq(TeamMembership::ROLE_ADMIN)
      end

      it "accepts PATCH", parity: true do
        log_in(seller)

        send_json(:patch, settings_team_member_path(membership.external_id, format: :json), team_membership: { role: TeamMembership::ROLE_SUPPORT })

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.role).to eq(TeamMembership::ROLE_SUPPORT)
      end

      it "removes a member and restores them", parity: true do
        log_in(seller)

        send_json(:delete, settings_team_member_path(membership.external_id, format: :json))

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.deleted?).to be(true)

        send_json(:put, restore_settings_team_member_path(membership.external_id, format: :json))

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.deleted?).to be(false)
      end

      it "lets a member leave the team", parity: true do
        log_in(member)
        switch_to(membership)

        send_json(:delete, settings_team_member_path(membership.external_id, format: :json))

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.deleted?).to be(true)
      end

      it "answers 404 JSON for a membership of another seller", parity: true do
        other = create(:team_membership, role: TeamMembership::ROLE_SUPPORT)
        log_in(seller)

        send_json(:delete, settings_team_member_path(other.external_id, format: :json))

        expect(response).to have_http_status(:not_found)
        expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
        expect(other.reload.deleted?).to be(false)
      end

      [["a role outside the team roles", "chief"], ["a numeric role", 7], ["a null role", nil]].each do |label, role|
        it "answers 422 and keeps the role for #{label}", parity: true do
          log_in(seller)

          send_json(:put, settings_team_member_path(membership.external_id, format: :json), team_membership: { role: })

          expect(response).to have_http_status(:unprocessable_entity)
          expect(membership.reload.role).to eq(TeamMembership::ROLE_MARKETING)
        end
      end

      it "answers 422 when restoring a membership the member has since joined again", parity: true do
        membership.update_as_deleted!
        create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(seller)

        send_json(:put, restore_settings_team_member_path(membership.external_id, format: :json))

        expect(response).to have_http_status(:unprocessable_entity)
        expect(membership.reload.deleted?).to be(true)
      end

      it "refuses a member whose role cannot manage the team", parity: true do
        member_with_role(TeamMembership::ROLE_SUPPORT)

        send_json(:put, settings_team_member_path(membership.external_id, format: :json), team_membership: { role: TeamMembership::ROLE_ADMIN })

        expect(response).to have_http_status(:unauthorized)
        expect(membership.reload.role).to eq(TeamMembership::ROLE_MARKETING)
      end

      it "lists the owner, the members and the pending invitations", parity: true do
        create(:team_invitation, seller:, email: "invitee@example.com", role: TeamInvitation::ROLES.first)
        log_in(seller)

        send_json(:get, settings_team_members_path(format: :json))

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["member_infos"].pluck("type")).to eq(%w[owner membership invitation])
      end

      it "lists the team to a member with the options of their role", parity: true do
        member_with_role(TeamMembership::ROLE_SUPPORT)

        send_json(:get, settings_team_members_path(format: :json))

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["member_infos"].pluck("type")).to include("membership")
      end

      it "answers 403 JSON to a seller without an email address when listing the team", parity: true do
        log_in(seller)
        seller.update_columns(email: nil, unconfirmed_email: nil)

        send_json(:get, settings_team_members_path(format: :json))

        expect(response).to have_http_status(:forbidden)
      end

      it "hands a request without a team_membership hash to Rails", parity: true do
        log_in(seller)

        send_json(:put, settings_team_member_path(membership.external_id, format: :json), {})

        expect(response).to have_http_status(:bad_request)
      end

      it "hands a removal of a member of the Gumroad account to Rails", parity: true do
        seller.update_columns(email: ApplicationMailer::ADMIN_EMAIL)
        log_in(seller)

        send_json(:delete, settings_team_member_path(membership.external_id, format: :json))

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.deleted?).to be(true)
      end
    end
  end
end
