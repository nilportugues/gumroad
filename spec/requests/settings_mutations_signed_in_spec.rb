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
end
