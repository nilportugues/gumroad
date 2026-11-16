# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the affiliates pages (index, onboarding, new, edit), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-dashboard.replay.test.ts,
# which sends the last request of each example.
describe "Affiliates pages when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Signed In Seller", timezone: "Pacific Time (US & Canada)") }
  let(:product_one) { create(:product, user: seller, name: "First product", unique_permalink: "first") }
  let(:product_two) { create(:product, user: seller, name: "Second product", unique_permalink: "second") }

  def add_affiliate(name:, products:, basis_points: 500, destination_url: nil, email: nil)
    affiliate_user = create(:affiliate_user, name:, email: email || "#{name.parameterize}@example.com")
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, affiliate_basis_points: basis_points, destination_url:)
    products.each_with_index do |product, index|
      assignment = create(:product_affiliate, affiliate:, product:, affiliate_basis_points: basis_points + (index * 100), destination_url: index.zero? ? "https://example.com/#{name.parameterize}" : nil)
      # Distinct stamps, so the list's tiebreaker (the newest assignment first) is not left to MySQL.
      assignment.update_columns(updated_at: Time.utc(2025, 1, 1) + (affiliate.id * 1.day) + index.hours)
    end
    affiliate
  end

  describe "Brazilian Stripe Connect accounts" do
    # An affiliate is needed or the index redirects to onboarding; it is added first, as a Brazilian account cannot gain one.
    before { add_affiliate(name: "Alice Affiliate", products: [product_one]) }

    it "turns affiliates off for a seller whose linked Stripe Connect account is Brazilian", parity: true do
      create(:merchant_account_stripe_connect, user: seller, country: "BR")
      seller.update_attribute(:check_merchant_account_is_linked, true)
      log_in(seller)

      get affiliates_path

      expect(inertia_props_of(response)["affiliates_disabled_reason"]).to eq("Affiliates with Brazilian Stripe accounts are not supported.")
    end

    it "keeps affiliates on for a Brazilian Stripe Connect account that is not linked", parity: true do
      create(:merchant_account_stripe_connect, user: seller, country: "BR")
      log_in(seller)

      get affiliates_path

      expect(inertia_props_of(response)["affiliates_disabled_reason"]).to be_nil
    end
  end

  describe "index" do
    before do
      add_affiliate(name: "Alice Affiliate", products: [product_one, product_two])
      add_affiliate(name: "Bob Booster", products: [product_one], basis_points: 1500)
      add_affiliate(name: "Carol Creator", products: [], basis_points: 2500, destination_url: "https://example.com/carol")
      create(:affiliate_request, seller:, name: "Dan Applicant", email: "dan@example.com", promotion_text: "I have a newsletter")
      approved = create(:affiliate_request, seller:, name: "Erin Approved", email: "erin@example.com")
      approved.update_columns(state: "approved")
    end

    it "lists the affiliates, their products and the pending requests", parity: true do
      log_in(seller)

      get affiliates_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["affiliates"].size).to eq(3)
      expect(props["affiliate_requests"].size).to eq(2)
    end

    it "filters by a search query", parity: true do
      log_in(seller)

      get affiliates_path(query: " booster ")

      expect(inertia_props_of(response)["affiliates"].map { _1["affiliate_user_name"] }).to eq(["Bob Booster"])
    end

    %w[affiliate_user_name products fee_percent volume_cents].each do |column|
      it "sorts by #{column} descending", parity: true do
        log_in(seller)

        get affiliates_path(column:, sort: "desc")

        expect(response).to be_successful
      end
    end

    it "clamps a page past the end to the last page", parity: true do
      log_in(seller)

      get affiliates_path(page: "7")

      expect(inertia_props_of(response)["pagination"]).to eq("pages" => 1, "page" => 1)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      inertia_visit affiliates_path

      expect(response).to be_successful
      expect(response.parsed_body["props"]).to include("affiliates", "affiliate_requests", "pagination", "allow_approve_all_requests")
    end

    it "lets a support team member view the list but marks requests as not updatable", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      get affiliates_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["affiliate_requests"].map { _1["can_update"] }).to eq([false, false])
    end

    it "lets a marketing team member update requests", parity: true do
      member = create(:user, name: "Team Marketing")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
      log_in(member)
      switch_to(membership)

      get affiliates_path

      expect(inertia_props_of(response)["affiliate_requests"].map { _1["can_update"] }).to eq([true, true])
    end
  end

  describe "index without affiliates" do
    it "sends a seller with nothing set up to the onboarding page", parity: true do
      log_in(seller)

      get affiliates_path

      expect(response).to redirect_to(onboarding_affiliates_path)
    end

    it "renders the page for a seller who enabled a self-service product", parity: true do
      create(:self_service_affiliate_product, seller:, product: product_one, enabled: true)
      log_in(seller)

      get affiliates_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["affiliates"]).to eq([])
    end

    it "does not redirect a search with no matches", parity: true do
      log_in(seller)

      get affiliates_path(query: "nobody")

      expect(response).to be_successful
    end


    it "sends an accountant who can view the list on to the onboarding page", parity: true do
      member = create(:user, name: "Team Accountant")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
      log_in(member)
      switch_to(membership)

      get affiliates_path

      expect(response).to redirect_to(onboarding_affiliates_path)
    end
  end

  describe "onboarding" do
    it "lists the sellable products and the global affiliate settings", parity: true do
      product_one
      create(:self_service_affiliate_product, seller:, product: product_two, enabled: true, affiliate_basis_points: 2000, destination_url: "https://example.com/two")
      create(:product, user: seller, name: "Archived product").update!(archived: true)
      log_in(seller)

      get onboarding_affiliates_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["products"].map { _1["name"] }).to eq(["Second product", "First product"])
    end

    it "flags a seller whose only products are collabs", parity: true do
      create(:product, user: seller).update_columns(flags: Link.flag_mapping["flags"][:is_collab])
      log_in(seller)

      get onboarding_affiliates_path

      expect(inertia_props_of(response)).to include("products" => [], "collab_products_only" => true)
    end

    it "shows a seller who disabled the global affiliate", parity: true do
      seller.update!(disable_global_affiliate: true)
      log_in(seller)

      get onboarding_affiliates_path

      expect(inertia_props_of(response)["disable_global_affiliate"]).to eq(true)
    end

    it "sends a support team member to the dashboard from the new page", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      get new_affiliate_path

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end
  end

  describe "new" do
    it "lists the products with empty settings", parity: true do
      product_one
      product_two
      log_in(seller)

      get new_affiliate_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["products"].map { _1.slice("name", "enabled", "referral_url") }).to eq(
        [{ "name" => "First product", "enabled" => false, "referral_url" => "" }, { "name" => "Second product", "enabled" => false, "referral_url" => "" }]
      )
    end
  end

  describe "edit" do
    it "shows the affiliate with a row for every product", parity: true do
      product_two
      affiliate = add_affiliate(name: "Alice Affiliate", products: [product_one])
      log_in(seller)

      get edit_affiliate_path(affiliate.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["affiliate"]["products"].map { [_1["name"], _1["enabled"]] }).to eq([["First product", true], ["Second product", false]])
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      affiliate = add_affiliate(name: "Alice Affiliate", products: [product_one])
      log_in(seller)

      inertia_visit edit_affiliate_path(affiliate.external_id)

      expect(response.parsed_body["props"]["affiliate"]).to include("affiliate_user_name" => "Alice Affiliate")
    end

    it "answers 404 for another seller's affiliate", parity: true do
      other = create(:direct_affiliate, seller: create(:user))
      log_in(seller)

      get edit_affiliate_path(other.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an id that is not an affiliate", parity: true do
      log_in(seller)

      get "/affiliates/not-an-id/edit"

      expect(response).to have_http_status(:not_found)
    end
  end
end
