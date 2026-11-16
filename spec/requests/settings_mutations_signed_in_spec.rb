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

    it "stores float snippet fields as their text", parity: true do
      create(:product, user: seller)
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: nil, name: 1.5, location: "receipt", code: 2.0, product: nil }]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.third_party_analytics.alive.sole).to have_attributes(name: "1.5", location: "receipt", analytics_code: "2.0", link_id: nil)
    end

    it "stores a float snippet location and a float product permalink that matches no product", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: nil, name: "Float location", location: 1.5, code: "<script>1</script>", product: 2.5 }]))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole).to have_attributes(location: "1.5", link_id: nil)
    end

    it "refuses two snippets with the same float location for all products", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                       { id: nil, name: "One", location: 1.5, code: "<script>1</script>", product: nil },
                                                                       { id: nil, name: "Two", location: 1.5, code: "<script>2</script>", product: nil }
                                                                     ]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to start_with("Only one analytics block is allowed per product.")
    end

    it "keeps a float and an integer snippet location apart", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                       { id: nil, name: "One", location: 1.0, code: "<script>1</script>", product: nil },
                                                                       { id: nil, name: "Two", location: 1, code: "<script>2</script>", product: nil }
                                                                     ]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.third_party_analytics.alive.order(:id).pluck(:location)).to eq(["1.0", "1"])
    end

    it "stores an integer Facebook pixel id past 2**53 digit for digit", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(facebook_pixel_id: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.reload.facebook_pixel_id).to eq("12345678901234567890")
    end

    it "answers an integer TikTok pixel id past 2**53 with the generic failure", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(tiktok_pixel_id: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Something broke. We're looking into what happened. Sorry about this!")
    end

    it "stores snippet fields with an integer past 2**53 digit for digit", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [{ id: nil, name: 12345678901234567890, location: "receipt", code: 98765432109876543210, product: nil }]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.third_party_analytics.alive.sole).to have_attributes(name: "12345678901234567890", analytics_code: "98765432109876543210")
    end

    def snippet_with(**fields)
      analytics(snippets: [{ id: nil, name: "Name", location: "receipt", code: "<script>1</script>", product: nil }.merge(fields)])
    end

    it "casts a float snippet name and code like text columns", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(name: 1.5, code: 2.0))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(seller.third_party_analytics.alive.sole).to have_attributes(name: "1.5", analytics_code: "2.0")
    end

    it "casts a float snippet location like a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(location: 1.5))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole.location).to eq("1.5")
    end

    it "looks a float permalink up as a string", parity: true do
      create(:product, user: seller)
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(product: 4242.5))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole.link_id).to be_nil
    end

    it "treats two snippets with the same float location as one place", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                      { id: nil, name: "One", location: 1.5, code: "a", product: nil },
                                                                      { id: nil, name: "Two", location: 1.5, code: "b", product: nil },
                                                                    ]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Only one analytics block")
    end

    it "does not take a float location for the same place as its text", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, analytics(snippets: [
                                                                      { id: nil, name: "One", location: 1.5, code: "a", product: nil },
                                                                      { id: nil, name: "Two", location: "1.5", code: "b", product: nil },
                                                                    ]))

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
    end

    it "answers a float snippet id like one that matches no snippet", parity: true do
      kept = create(:third_party_analytic, user: seller, link: nil, name: "Kept", location: "all", analytics_code: "<script>old()</script>")
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(id: 1.5))

      expect(response).to have_http_status(:see_other)
      expect(kept.reload.deleted_at).to be_present
    end

    it "stores a snippet name and code with an integer past 2**53 digit for digit", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(name: 12345678901234567890, code: 12345678901234567891))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole).to have_attributes(name: "12345678901234567890", analytics_code: "12345678901234567891")
    end

    it "stores a snippet location with an integer past 2**53 digit for digit", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(location: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole.location).to eq("12345678901234567890")
    end

    it "looks a permalink with an integer past 2**53 up as a string", parity: true do
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(product: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(seller.third_party_analytics.alive.sole.link_id).to be_nil
    end

    it "answers a snippet id with an integer past 2**53 like one that matches no snippet", parity: true do
      kept = create(:third_party_analytic, user: seller, link: nil, name: "Kept", location: "all", analytics_code: "<script>old()</script>")
      log_in(seller)

      send_form(:put, settings_third_party_analytics_path, snippet_with(id: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(kept.reload.deleted_at).to be_present
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

    it "casts an integer ping endpoint past 2**53 like a text column", parity: true do
      log_in(seller)

      send_form(:put, settings_advanced_path, advanced(endpoint: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.notification_endpoint).to eq("http://12345678901234567890")
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

    describe "custom domain" do
      # Gumroad's own targets resolve and the names in CNAMED_TO_GUMROAD carry a CNAME to Gumroad; nothing else resolves, so any other seller
      # domain does not point at Gumroad. Keep the replay's zone (settings-mutations.replay.test.ts) in sync.
      CNAMED_TO_GUMROAD = %w[points.example.com verified-old.example.com].freeze

      before do
        allow_any_instance_of(Resolv::DNS).to receive(:getresources) do |_dns, name, type|
          if type == Resolv::DNS::Resource::IN::CNAME
            CNAMED_TO_GUMROAD.include?(name) ? [double(name: CUSTOM_DOMAIN_CNAME)] : []
          else
            [CUSTOM_DOMAIN_CNAME, CUSTOM_DOMAIN_STATIC_IP_HOST].include?(name) ? [double(address: "203.0.113.7")] : []
          end
        end
      end

      # The factory's save clears the certificate date (a new domain always does) and schedules a certificate, so set the date afterwards
      # and drop the job it queued.
      def stored_domain(**attributes)
        create(:custom_domain, user: seller, **attributes).tap do
          _1.update_columns(ssl_certificate_issued_at: 1.day.ago)
          GenerateSslCertificate.jobs.clear
        end
      end

      it "saves a custom domain that does not point at Gumroad yet and schedules its certificate", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "Store.Example.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated!")
        expect(seller.reload.custom_domain).to have_attributes(domain: "store.example.com", state: "unverified", ssl_certificate_issued_at: nil)
        expect(GenerateSslCertificate.jobs.size).to eq(1)
      end

      it "saves a custom domain that points at Gumroad as verified and schedules its certificate", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "points.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:notice]).to eq("Your account has been updated!")
        expect(seller.reload.custom_domain).to have_attributes(domain: "points.example.com", state: "verified", failed_verification_attempts_count: 0, ssl_certificate_issued_at: nil)
        expect(GenerateSslCertificate.jobs.size).to eq(1)
      end

      it "verifies an unverified domain that now points at Gumroad and resets its failed attempts", parity: true do
        stored_domain(domain: "points.example.com", state: "unverified").update_columns(failed_verification_attempts_count: 2)
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "points.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to have_attributes(state: "verified", failed_verification_attempts_count: 0)
        expect(seller.custom_domain.ssl_certificate_issued_at).to be_present
        expect(GenerateSslCertificate.jobs.size).to eq(0)
      end

      it "keeps a verified domain verified when it is changed to another that points at Gumroad", parity: true do
        stored_domain(domain: "old.example.com", state: "verified")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "verified-old.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to have_attributes(domain: "verified-old.example.com", state: "verified", ssl_certificate_issued_at: nil)
        expect(GenerateSslCertificate.jobs.size).to eq(1)
      end

      it "refuses a domain another seller already uses even when it points at Gumroad", parity: true do
        create(:custom_domain, user: create(:user), domain: "points.example.com")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "points.example.com", endpoint: "https://example.com/ping"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("The custom domain is already in use.")
        expect(seller.reload.custom_domain).to be_nil
      end

      it "verifies the domain as typed, so one padded with spaces is saved unverified", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "  points.example.com  "))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to have_attributes(domain: "points.example.com", state: "unverified")
      end

      it "strips the spaces around the saved domain", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "  shop.example.org  "))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain.domain).to eq("shop.example.org")
      end

      it "marks a verified domain unverified when it is changed to one that does not point at Gumroad", parity: true do
        stored_domain(domain: "old.example.com", state: "verified")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "new.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to have_attributes(domain: "new.example.com", state: "unverified", ssl_certificate_issued_at: nil)
        expect(CustomDomain.where(user_id: seller.id).count).to eq(1)
      end

      it "keeps an unverified domain unverified and leaves its certificate alone when the name is unchanged", parity: true do
        stored_domain(domain: "same.example.com", state: "unverified")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "same.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain.ssl_certificate_issued_at).to be_present
        expect(GenerateSslCertificate.jobs.size).to eq(0)
      end

      it "marks a verified domain unverified when the same name no longer points at Gumroad", parity: true do
        stored_domain(domain: "same.example.com", state: "verified")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "same.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to have_attributes(state: "unverified")
        expect(seller.custom_domain.ssl_certificate_issued_at).to be_present
      end

      it "saves the ping endpoint and the domain together", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "both.example.com", endpoint: "https://example.com/ping"))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload).to have_attributes(notification_endpoint: "https://example.com/ping")
        expect(seller.custom_domain.domain).to eq("both.example.com")
      end

      it "refuses a domain another seller already uses and keeps the ping endpoint", parity: true do
        create(:custom_domain, user: create(:user), domain: "taken.example.com")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "taken.example.com", endpoint: "https://example.com/ping"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("The custom domain is already in use.")
        expect(seller.reload.notification_endpoint).to eq("https://example.com/ping")
        expect(seller.custom_domain).to be_nil
      end

      it "refuses the www variant of a domain another seller already uses", parity: true do
        create(:custom_domain, user: create(:user), domain: "www.mysite.com")
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "mysite.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("The custom domain is already in use.")
      end

      it "refuses a label that starts with a hyphen", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "-shop.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("-shop.example.com is not a valid domain name.")
        expect(seller.reload.custom_domain).to be_nil
      end

      it "refuses an empty label", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "shop..example.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("shop..example.com is not a valid domain name.")
      end

      it "refuses a name with a character a hostname cannot carry", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "my_shop.example.com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("my_shop.example.com is not a valid domain name.")
      end

      it "refuses an IP address", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "203.0.113.7"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("203.0.113.7 is not a valid domain name.")
      end

      it "refuses a bare public suffix", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "com"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("com is not a valid domain name.")
      end

      it "refuses a domain under Gumroad's own", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "shop.#{INTERNAL_GUMROAD_DOMAIN}"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("shop.#{INTERNAL_GUMROAD_DOMAIN} is not a valid domain name.")
        expect(seller.reload.custom_domain).to be_nil
      end

      it "says it twice for a domain under Gumroad's own when its port is no hostname character", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "shop.#{DOMAIN}"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("shop.#{DOMAIN} is not a valid domain name. and shop.#{DOMAIN} is not a valid domain name.")
      end

      it "gives both messages for a Gumroad domain with a malformed label", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "-shop.#{DOMAIN}"))

        expect(response).to have_http_status(:see_other)
        expect(flash[:alert]).to eq("-shop.#{DOMAIN} is not a valid domain name. and -shop.#{DOMAIN} is not a valid domain name.")
      end

      it "ignores a domain made of spaces", parity: true do
        log_in(seller)

        send_form(:put, settings_advanced_path, advanced(domain: "   "))

        expect(response).to have_http_status(:see_other)
        expect(seller.reload.custom_domain).to be_nil
      end
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

    it "casts an integer past 2**53 like a varchar column", parity: true do
      log_in(seller)

      send_form(:put, settings_billing_path, billing(business_id: 12345678901234567890))

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.billing_detail.business_id).to eq("12345678901234567890")
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

      it "answers 400 to a request without a team_membership hash", parity: true do
        log_in(seller)

        send_json(:put, settings_team_member_path(membership.external_id, format: :json), {})

        expect(response).to have_http_status(:bad_request)
      end

      it "removes a member of the Gumroad account who is not a team member", parity: true do
        seller.update_columns(email: ApplicationMailer::ADMIN_EMAIL)
        log_in(seller)

        send_json(:delete, settings_team_member_path(membership.external_id, format: :json))

        expect(response.parsed_body).to eq("success" => true)
        expect(membership.reload.deleted?).to be(true)
      end
    end
  end
end
