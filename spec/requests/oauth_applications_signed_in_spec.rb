# frozen_string_literal: true

require "spec_helper"

# Managing OAuth applications, access tokens and authorized applications the way the settings pages do (Inertia JSON bodies with the CSRF
# token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/oauth-integrations.replay.test.ts,
# which sends the last request of each example.
describe "OAuth applications when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "OAuth Seller") }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/settings/advanced" }
  end
  let(:json_headers) { { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_form(method, path, headers: inertia_headers, **body)
    public_send(method, path, params: body.to_json, headers: headers.merge("X-CSRF-Token" => csrf_token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def create_application(**attributes)
    create(:oauth_application, owner: seller, name: "Seller app", redirect_uri: "https://example.com/callback", **attributes)
  end

  describe "creating and updating" do
    it "creates an application", parity: true do
      log_in(seller)

      send_form(:post, "/oauth/applications", oauth_application: { name: "My app", redirect_uri: "https://example.com/callback", affiliate_percent: "10" })

      application = OauthApplication.last
      expect(response).to redirect_to(edit_oauth_application_path(application.external_id))
      expect(application).to have_attributes(name: "My app", owner: seller, scopes: be_a(Doorkeeper::OAuth::Scopes))
    end

    it "refuses the reserved agent name", parity: true do
      log_in(seller)

      send_form(:post, "/oauth/applications", oauth_application: { name: "  gumroad store agent (internal) ", redirect_uri: "https://example.com/callback" })

      expect(response).to redirect_to(settings_advanced_path)
      expect(OauthApplication.count).to eq(0)
    end

    it "hands an application without a name back to Rails", parity: true do
      log_in(seller)

      send_form(:post, "/oauth/applications", oauth_application: { name: "", redirect_uri: "https://example.com/callback" })

      expect(response).to redirect_to(settings_advanced_path)
      expect(OauthApplication.count).to eq(0)
    end

    it "hands an application with a redirect URI Node cannot judge back to Rails", parity: true do
      log_in(seller)

      send_form(:post, "/oauth/applications", oauth_application: { name: "Native", redirect_uri: "myapp://callback" })

      expect(response).to redirect_to(edit_oauth_application_path(OauthApplication.last.external_id))
    end

    it "hands an application with an icon back to Rails", parity: true do
      log_in(seller)

      send_form(:post, "/oauth/applications", oauth_application: { name: "With icon", redirect_uri: "https://example.com/callback" }, signed_blob_id: "tampered")

      expect(response).to redirect_to(settings_advanced_path)
    end

    it "does not let a marketing team member create an application", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_form(:post, "/oauth/applications", oauth_application: { name: "My app", redirect_uri: "https://example.com/callback" })

      expect(response).to redirect_to(dashboard_url)
      expect(OauthApplication.count).to eq(0)
    end

    it "lets an admin team member create an application for the seller", parity: true do
      as_team_member(TeamMembership::ROLE_ADMIN)

      send_form(:post, "/oauth/applications", oauth_application: { name: "Admin app", redirect_uri: "https://example.com/callback" })

      expect(OauthApplication.last.owner).to eq(seller)
    end

    it "updates the name and redirect URI", parity: true do
      application = create_application
      log_in(seller)

      send_form(:patch, oauth_application_path(application.external_id), oauth_application: { name: "Renamed", redirect_uri: "https://example.com/new" })

      expect(response).to redirect_to(edit_oauth_application_path(application.external_id))
      expect(application.reload).to have_attributes(name: "Renamed", redirect_uri: "https://example.com/new")
    end

    it "keeps the current values for blank fields on PUT", parity: true do
      application = create_application
      log_in(seller)

      send_form(:put, oauth_application_path(application.external_id), oauth_application: { name: "", redirect_uri: "" })

      expect(application.reload.name).to eq("Seller app")
    end

    it "redirects with an alert for an unknown application", parity: true do
      log_in(seller)

      send_form(:patch, oauth_application_path("unknown"), oauth_application: { name: "Renamed" })

      expect(response).to redirect_to(oauth_applications_url)
      expect(flash[:alert]).to eq("Application not found or you don't have the permissions to modify it.")
    end

    it "does not touch another seller's application", parity: true do
      other = create(:oauth_application, owner: create(:user), name: "Other")
      log_in(seller)

      send_form(:patch, oauth_application_path(other.external_id), oauth_application: { name: "Hijacked" })

      expect(other.reload.name).to eq("Other")
    end
  end

  describe "deleting" do
    it "marks the application deleted and revokes what hangs off it", parity: true do
      application = create_application
      token = create("doorkeeper/access_token", application:, resource_owner_id: seller.id)
      Doorkeeper::AccessGrant.create!(application:, resource_owner_id: seller.id, redirect_uri: application.redirect_uri, expires_in: 600, scopes: "view_sales")
      create(:resource_subscription, oauth_application: application, user: seller)
      log_in(seller)

      send_form(:delete, oauth_application_path(application.external_id))

      expect(response).to redirect_to(settings_advanced_path)
      expect(application.reload).to be_deleted
      expect(token.reload.revoked_at).to be_present
    end

    it "does not let a support team member delete an application", parity: true do
      application = create_application
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_form(:delete, oauth_application_path(application.external_id))

      expect(response).to redirect_to(dashboard_url)
      expect(application.reload).not_to be_deleted
    end
  end

  describe "access tokens" do
    it "generates a token and answers it again on the next request", parity: true do
      application = create_application
      log_in(seller)

      send_form(:post, "/settings/applications/#{application.external_id}/access_tokens", headers: json_headers)
      first = response.parsed_body["token"]
      send_form(:post, "/settings/applications/#{application.external_id}/access_tokens", headers: json_headers)

      expect(response.parsed_body).to eq("success" => true, "token" => first)
      expect(Doorkeeper::AccessToken.count).to eq(1)
      expect(Doorkeeper::AccessGrant.count).to eq(1)
    end

    it "answers the token that already exists", parity: true do
      application = create_application
      application.get_or_generate_access_token
      log_in(seller)

      send_form(:post, "/settings/applications/#{application.external_id}/access_tokens", headers: json_headers)

      expect(response.parsed_body["success"]).to be(true)
      expect(Doorkeeper::AccessToken.count).to eq(1)
    end

    it "answers 404 JSON for an unknown application", parity: true do
      log_in(seller)

      send_form(:post, "/settings/applications/unknown/access_tokens", headers: json_headers)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["success"]).to be(false)
    end

    it "refuses a support team member", parity: true do
      application = create_application
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_form(:post, "/settings/applications/#{application.external_id}/access_tokens", headers: json_headers)

      expect(response).to have_http_status(:unauthorized)
      expect(Doorkeeper::AccessToken.count).to eq(0)
    end
  end

  describe "authorized applications" do
    let(:application) { create(:oauth_application, owner: create(:user), name: "Third party") }

    it "revokes an application the user authorized", parity: true do
      token = create("doorkeeper/access_token", application:, resource_owner_id: seller.id)
      create(:resource_subscription, oauth_application: application, user: seller)
      log_in(seller)

      send_form(:delete, "/oauth/authorized_applications/#{application.external_id}")

      expect(response).to redirect_to(settings_authorized_applications_path)
      expect(flash[:notice]).to eq("Authorized application revoked")
      expect(token.reload.revoked_at).to be_present
    end

    it "alerts when the user never authorized the application", parity: true do
      log_in(seller)

      send_form(:delete, "/oauth/authorized_applications/#{application.external_id}")

      expect(flash[:alert]).to eq("Authorized application could not be revoked")
    end
  end

  describe "redirects" do
    it "redirects the applications index and new pages to the advanced settings", parity: true do
      log_in(seller)

      get "/oauth/applications"
      expect(response).to redirect_to(settings_advanced_path)
      get "/oauth/applications/new"

      expect(response).to redirect_to(settings_advanced_path)
    end

    it "redirects an application to its editor", parity: true do
      log_in(seller)

      get "/oauth/applications/abc123"

      expect(response).to redirect_to(edit_oauth_application_path("abc123"))
    end

    it "redirects the authorized applications index", parity: true do
      log_in(seller)

      get "/oauth/authorized_applications"

      expect(response).to redirect_to(settings_authorized_applications_path)
    end
  end
end
