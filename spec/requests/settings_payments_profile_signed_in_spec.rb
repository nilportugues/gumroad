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

    it "answers an Inertia visit with the page as JSON", parity: true do
      create(:user_compliance_info, user: seller)
      log_in(seller)

      get settings_payments_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Settings/Payments/Show")
    end
  end
end
