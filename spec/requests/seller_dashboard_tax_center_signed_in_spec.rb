# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the tax center, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/seller-dashboard.replay.test.ts, which sends the last request of each example.
describe "Tax center page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Signed In Seller", created_at: 3.years.ago) }

  before { create(:user_compliance_info, user: seller) }

  it "lists the tax form with the year's totals", parity: true do
    year = Time.current.year - 1
    create(:user_tax_form, user: seller, tax_year: year, tax_form_type: "us_1099_k")
    product = create(:product, user: seller)
    [Time.zone.local(year, 6, 1), Time.zone.local(year, 12, 31, 12), Time.zone.local(year + 1, 1, 1)].each_with_index do |created_at, index|
      create(:free_purchase, link: product).update_columns(
        created_at:, price_cents: 1000, total_transaction_cents: 1000 + index, fee_cents: 100, tax_cents: 5, gumroad_tax_cents: 10, affiliate_credit_cents: 20
      )
    end
    log_in(seller)

    get tax_center_path

    expect(response).to be_successful
    document = inertia_props_of(response)["documents"].first
    expect(document).to include("document" => "1099-K", "form_type" => "us_1099_k")
  end

  it "shows a filed form and a transaction report for a Stripe account", parity: true do
    year = Time.current.year - 1
    create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_tax_center_1")
    create(:user_tax_form, user: seller, tax_year: year, tax_form_type: "us_1099_misc", filed_at: Time.utc(year + 1, 1, 31).to_i)
    log_in(seller)

    get tax_center_path

    expect(inertia_props_of(response)["documents"].first).to include("document" => "1099-MISC", "filed_at" => "January 31, #{year + 1}")
  end

  it "reports the transaction report as available for a 1099-K on the seller's Stripe account", parity: true do
    # An earlier year than the other examples: Rails.cache.fetch keeps the document per seller id, type and
    # year for the whole process, and every example starts from the same ids.
    year = Time.current.year - 2
    create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_tax_center_2")
    create(:user_tax_form, user: seller, tax_year: year, tax_form_type: "us_1099_k")
    log_in(seller)

    get tax_center_path(year:)

    expect(inertia_props_of(response)["documents"].first["transaction_report_available"]).to eq(true)
  end

  it "renders no documents for a year without a form", parity: true do
    log_in(seller)

    get tax_center_path(year: Time.current.year - 2)

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("documents" => [], "selected_year" => Time.current.year - 2)
  end

  it "falls back to the latest year for a year outside the seller's history", parity: true do
    log_in(seller)

    get tax_center_path(year: "1999")

    expect(inertia_props_of(response)["selected_year"]).to eq(Time.current.year - 1)
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    log_in(seller)

    inertia_visit tax_center_path

    expect(response).to be_successful
    expect(response.parsed_body["props"]).to include("documents", "available_years", "selected_year")
  end

  it "sends a seller outside the US to the dashboard", parity: true do
    seller.alive_user_compliance_info.mark_deleted!
    create(:user_compliance_info_singapore, user: seller)
    log_in(seller)

    get tax_center_path

    expect(response).to redirect_to(dashboard_path)
    expect(flash[:alert]).to eq("Tax center is not enabled for your account.")
  end


  it "lets an accountant team member in", parity: true do
    member = create(:user, name: "Team Accountant")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(member)
    switch_to(membership)

    get tax_center_path

    expect(response).to be_successful
  end

  it "sends a marketing team member to the dashboard with the role in the flash", parity: true do
    member = create(:user, name: "Team Marketing")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    get tax_center_path

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
  end
end
