# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the settings pages, recorded for the Next.js port (PARITY_RECORD=1) through the
# full Rack stack after a real login. Replayed by nextjs/parity/__tests__/settings-pages.replay.test.ts,
# which sends the last request of each example.
describe "Settings pages when signed in", type: :request do
  let(:seller) { create(:user, name: "Settings Seller", username: "settingsseller") }

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

  describe "main" do
    it "renders the settings for the owner", parity: true do
      create(:product, user: seller, name: "Visible product")
      log_in(seller)

      get settings_main_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["is_form_disabled"]).to eq(false)
      expect(props["user"]["products"].map { _1["name"] }).to eq(["Visible product"])
    end

    it "renders the settings with purchasing power parity and an unconfirmed email", parity: true do
      product = create(:product, user: seller)
      seller.update!(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: 40, support_email: "support@example.com", locale: "en", timezone: "Tokyo", currency_type: "eur")
      seller.update_purchasing_power_parity_excluded_products!([product.external_id])
      seller.update_columns(unconfirmed_email: "new@example.com")
      log_in(seller)

      get settings_main_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["user"]).to include("has_unconfirmed_email" => true, "email" => "new@example.com")
    end

    it "renders the settings read only for an admin team member", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_main_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["is_form_disabled"]).to eq(true)
    end

    it "sends a support team member to the profile", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      get settings_main_path

      expect(response).to redirect_to(profile_path)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      get settings_main_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Settings/Main/Show")
    end

    it "sends a signed-out visitor to the login page" do
      get settings_main_path

      expect(response).to have_http_status(:found)
    end
  end

  describe "password" do
    it "renders the page for the owner", parity: true do
      log_in(seller)

      get settings_password_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["require_old_password"]).to eq(true)
    end

    it "lists the passkeys of the owner", parity: true do
      create(:webauthn_credential, user: seller)
      log_in(seller)

      get settings_password_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["passkeys"].size).to eq(1)
    end

    it "sends an admin team member to the dashboard with a flash", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_password_path

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Admin cannot perform this action.")
    end
  end

  describe "social connections" do
    it "renders the page for the owner", parity: true do
      log_in(seller)

      get settings_social_connections_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("twitter_connected" => false)
    end

    it "sends a marketing team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_MARKETING)

      get settings_social_connections_path

      expect(response).to redirect_to(dashboard_url)
    end
  end

  describe "third party analytics" do
    it "renders the page with the snippets of the owner", parity: true do
      product = create(:product, user: seller, name: "Analytics product")
      create(:third_party_analytic, user: seller, link: product)
      seller.update!(google_analytics_id: "G-ABC123", facebook_pixel_id: "1234567890")
      log_in(seller)

      get settings_third_party_analytics_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["third_party_analytics"]["snippets"].size).to eq(1)
    end

    it "renders the page for an admin team member", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_third_party_analytics_path

      expect(response).to be_successful
    end

    it "sends a support team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      get settings_third_party_analytics_path

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end
  end

  describe "advanced" do
    it "renders the page for the owner", parity: true do
      create(:blocked_customer_object, seller:, object_value: "blocked@example.com", blocked_at: Time.current)
      create(:oauth_application, owner: seller, name: "My app")
      seller.update!(notification_endpoint: "https://example.com/ping")
      log_in(seller)

      get settings_advanced_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["blocked_customer_emails"]).to eq("blocked@example.com")
      expect(props["applications"].size).to eq(1)
    end

    it "renders the page for an admin team member", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_advanced_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["allow_deactivation"]).to eq(false)
    end

    it "renders the page of a seller with a verified custom domain", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "store.example.com")
      log_in(seller)

      get settings_advanced_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["custom_domain_name"]).to eq("store.example.com")
    end
  end

  describe "billing" do
    it "renders the empty form for the owner", parity: true do
      log_in(seller)

      get settings_billing_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["billing_detail"]).to include("full_name" => "Settings Seller")
    end

    it "renders the saved billing details", parity: true do
      create(:billing_detail, :us, purchaser: seller, additional_notes: "PO 42")
      log_in(seller)

      get settings_billing_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["billing_detail"]).to include("country_code" => "US", "additional_notes" => "PO 42")
    end

    it "sends an admin team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)

      get settings_billing_path

      expect(response).to redirect_to(dashboard_url)
    end
  end

  describe "team" do
    it "lists the owner, members and invitations", parity: true do
      create(:team_membership, user: create(:user, name: "Support Member"), seller:, role: TeamMembership::ROLE_SUPPORT)
      create(:team_membership, user: create(:user, name: "Marketing Member"), seller:, role: TeamMembership::ROLE_MARKETING)
      create(:team_invitation, seller:, email: "invited@example.com", role: TeamMembership::ROLE_ACCOUNTANT)
      create(:team_invitation, seller:, email: "expired@example.com", role: TeamMembership::ROLE_ADMIN, expires_at: 1.day.ago)
      log_in(seller)

      get settings_team_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["member_infos"].size).to eq(5)
    end

    it "lists the team for an admin member, who can leave", parity: true do
      create(:team_invitation, seller:, email: "invited@example.com", role: TeamMembership::ROLE_SUPPORT)
      member_with_role(TeamMembership::ROLE_ADMIN, name: "Admin Member")

      get settings_team_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["can_invite_member"]).to eq(true)
    end

    it "lists the team read only for a support member", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT, name: "Support Member")

      get settings_team_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["can_invite_member"]).to eq(false)
    end

    it "sends an owner without an email to the main settings", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: "pending@example.com")

      get settings_team_path

      expect(response).to redirect_to(settings_main_path)
      expect(flash[:alert]).to start_with("Your Gumroad account doesn't have an email")
    end
  end

  describe "authorized applications" do
    it "renders the apps the owner authorized", parity: true do
      application = create(:oauth_application, owner: create(:user), name: "Third party app")
      create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "view_public edit_products")
      Doorkeeper::AccessGrant.create!(application:, resource_owner_id: seller.id, redirect_uri: application.redirect_uri, expires_in: 600, scopes: "view_public")
      log_in(seller)

      get settings_authorized_applications_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["authorized_applications"].size).to eq(1)
    end

    it "renders an empty list when nothing is authorized", parity: true do
      log_in(seller)

      get settings_authorized_applications_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["authorized_applications"]).to eq([])
    end

    it "sends a support team member to the dashboard", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      get settings_authorized_applications_path

      expect(response).to redirect_to(dashboard_url)
    end
  end
end
