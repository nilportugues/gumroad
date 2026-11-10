# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the collaborators page, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/seller-dashboard.replay.test.ts, which sends the last request
# of each example.
describe "Collaborators page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Signed In Seller") }

  it "lists the collaborators with their products", parity: true do
    product_one = create(:product, user: seller, name: "First product")
    product_two = create(:product, user: seller, name: "Second product")
    collaborator = create(:collaborator, seller:)
    collaborator.product_affiliates.create!(product: product_one, affiliate_basis_points: 50_00)
    collaborator.product_affiliates.create!(product: product_two, affiliate_basis_points: 35_00)
    create(:collaborator, seller:, affiliate_user: create(:user, payment_address: nil))
    create(:collaborator, :with_pending_invitation, seller:, products: [create(:product, user: seller, name: "Third product")])
    log_in(seller)

    get collaborators_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["collaborators"].size).to eq(3)
  end

  it "renders an empty list for a seller without collaborators", parity: true do
    log_in(seller)

    get collaborators_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("collaborators" => [], "has_incoming_collaborators" => false)
  end

  it "turns collaborators off for a seller whose linked Stripe Connect account is Brazilian", parity: true do
    create(:merchant_account_stripe_connect, user: seller, country: "BR")
    seller.update_attribute(:check_merchant_account_is_linked, true)
    log_in(seller)

    get collaborators_path

    expect(inertia_props_of(response)["collaborators_disabled_reason"]).to eq("Collaborators with Brazilian Stripe accounts are not supported.")
  end

  it "keeps collaborators on for a Brazilian Stripe Connect account that is not linked", parity: true do
    create(:merchant_account_stripe_connect, user: seller, country: "BR")
    log_in(seller)

    get collaborators_path

    expect(inertia_props_of(response)["collaborators_disabled_reason"]).to be_nil
  end

  it "flags a seller who is someone's collaborator", parity: true do
    create(:collaborator, seller: create(:user), affiliate_user: seller)
    log_in(seller)

    get collaborators_path

    expect(inertia_props_of(response)["has_incoming_collaborators"]).to eq(true)
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    create(:collaborator, seller:)
    log_in(seller)

    inertia_visit collaborators_path

    expect(response).to be_successful
    expect(response.parsed_body["props"]).to include("collaborators", "collaborators_disabled_reason")
  end

  it "shows an admin team member the account they switched into", parity: true do
    create(:collaborator, seller:)
    member = create(:user, name: "Team Admin")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get collaborators_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["collaborators"].size).to eq(1)
  end

  it "sends a support team member to the dashboard with the role in the flash", parity: true do
    member = create(:user, name: "Team Support")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get collaborators_path

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
  end

  it "does not set a flash when the member just switched accounts", parity: true do
    member = create(:user, name: "Team Marketing")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    get collaborators_path(account_switched: "true")

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to be_nil
  end

  it "asks a user without an email to add one", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    get collaborators_path

    expect(response).to redirect_to(settings_main_path)
    expect(flash[:warning]).to eq("Please add an email address to your account before continuing.")
  end

  describe "new" do
    it "lists the products a collaborator can be added to", parity: true do
      create(:product, user: seller, name: "Published product")
      create(:product, user: seller, name: "Draft product", draft: true)
      create(:product, user: seller, name: "Archived product").update!(archived: true)
      taken = create(:product, user: seller, name: "Taken product")
      create(:collaborator, seller:, products: [taken])
      create(:direct_affiliate, seller:, products: [create(:product, user: seller, name: "Affiliate product")])
      log_in(seller)

      get new_collaborator_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["form_data"]["products"].map { _1["name"] }).to eq(["Published product", "Draft product", "Taken product", "Affiliate product"])
    end

    it "sends a support team member to the dashboard", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      get new_collaborator_path

      expect(response).to redirect_to(dashboard_url)
    end

  end

  describe "edit" do
    let(:product_one) { create(:product, user: seller, name: "First product") }
    let(:product_two) { create(:product, user: seller, name: "Second product") }
    let(:collaborator) do
      create(:collaborator, seller:, apply_to_all_products: false, dont_show_as_co_creator: true).tap do |record|
        record.product_affiliates.create!(product: product_one, affiliate_basis_points: 35_00)
      end
    end

    it "fills the form from the collaboration", parity: true do
      collaborator
      product_two
      log_in(seller)

      get edit_collaborator_path(collaborator.external_id)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["form_data"]["products"].map { [_1["name"], _1["enabled"], _1["percent_commission"]] }).to eq([["First product", true, 35], ["Second product", false, 30]])
      expect(props["page_metadata"]["title"]).to eq(collaborator.affiliate_user.display_name(prefer_email_over_default_username: true))
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      inertia_visit edit_collaborator_path(collaborator.external_id)

      expect(response.parsed_body["props"]["form_data"]).to include("apply_to_all_products" => false, "dont_show_as_co_creator" => true)
    end

    it "answers 404 for an unknown id", parity: true do
      log_in(seller)
      # set_collaborator is prepended, so it also runs before the nav seeding: seed first, as Next.js seeds ahead of its guard.
      get collaborators_path

      get edit_collaborator_path("not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "sends the seller away from another seller's collaboration", parity: true do
      other = create(:collaborator, seller: create(:user))
      log_in(seller)

      get edit_collaborator_path(other.external_id)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end
  end
end
