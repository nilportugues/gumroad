# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the new product page (Products/New), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/seller-products.replay.test.ts.
describe "New product page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "New Product Seller") }

  it "shows a brand new seller the orientation text and no service products", parity: true do
    log_in(seller)

    get new_product_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("show_orientation_text" => true, "eligible_for_service_products" => false)
  end

  it "shows a seller with products no orientation text", parity: true do
    create(:product, user: seller, name: "Existing")
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)["show_orientation_text"]).to eq(false)
  end

  it "offers service products to an account older than 30 days", parity: true do
    seller.update_columns(created_at: 40.days.ago)
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)["eligible_for_service_products"]).to eq(true)
  end

  it "offers physical products to a seller who sells one", parity: true do
    create(:physical_product, user: seller, name: "Poster")
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)["native_product_types"]).to include("physical")
  end

  it "leaves physical products out for a new seller", parity: true do
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)["native_product_types"]).not_to include("physical")
  end

  it "reports a dismissed AI promo and the seller's currency", parity: true do
    seller.update_columns(currency_type: "eur")
    seller.update!(dismissed_create_products_with_ai_promo_alert: true)
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)).to include("ai_promo_dismissed" => true, "current_seller_currency_code" => "eur")
  end

  it "formats the release date in the seller's time zone", parity: true do
    seller.update_columns(timezone: "Tokyo")
    log_in(seller)

    get new_product_path

    expect(inertia_props_of(response)["release_at_date"]).to match(/\A[A-Z][a-z]+ \d{1,2}, \d{4}\z/)
  end

  it "shows a suspended seller no physical products", parity: true do
    seller.update_columns(user_risk_state: "suspended_for_fraud")
    create(:physical_product, user: seller, name: "Poster")
    log_in(seller)

    get new_product_path

    expect(response).to be_successful
  end

  %w[admin marketing].each do |role|
    it "lets a #{role} team member create products", parity: true do
      member = create(:user, name: "Team #{role}")
      membership = create(:team_membership, user: member, seller:, role:)
      log_in(member)
      switch_to(membership)

      get new_product_path

      expect(response).to be_successful
    end
  end

  %w[support accountant].each do |role|
    it "sends a #{role} team member to the dashboard", parity: true do
      member = create(:user, name: "Team #{role}")
      membership = create(:team_membership, user: member, seller:, role:)
      log_in(member)
      switch_to(membership)

      get new_product_path

      expect(response).to redirect_to(dashboard_url)
    end
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get new_product_path

    expect(response).to redirect_to(login_path(next: "/products/new"))
  end
end
