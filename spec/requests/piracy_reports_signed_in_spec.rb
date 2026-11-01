# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the piracy report pages, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws75-pages.replay.test.ts, which sends the last request of
# each example. The earned-access bar is an Elasticsearch aggregation, so no example stubs it: a
# seller without the skip flag reads as short of it.
describe "Piracy reports when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Piracy Seller") }
  let(:product) { create(:product, user: seller, name: "Design course") }

  before { Feature.activate_user(:piracy_reports, seller) }

  describe "GET /dashboard/piracy_reports" do
    it "redirects a signed-out visitor to the login page", parity: true do
      get piracy_reports_path

      expect(response).to redirect_to(login_path(next: "/dashboard/piracy_reports"))
    end

    it "lists the reports newest first with their product and outcome", parity: true do
      older = create(:piracy_report, seller:, product:, url: "https://example.net/older", state: "resolved", outcome: "removed")
      newer = create(:piracy_report, :awaiting_signature, seller:, product: create(:product, user: seller, name: "Archived course", archived: true), url: "https://example.org/newer")
      create(:piracy_report, url: "https://example.com/someone-elses")
      log_in(seller)

      get piracy_reports_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["reports"].map { _1["id"] }).to eq([newer.external_id, older.external_id])
      expect(props).to include("archived_tab_visible" => true, "can_report" => true)
    end

    it "lists no reports for a seller who has filed none", parity: true do
      log_in(seller)

      get piracy_reports_path

      expect(inertia_props_of(response)).to include("reports" => [], "archived_tab_visible" => false)
    end

    it "keeps the list but not the new report button for a seller who lost the flag", parity: true do
      create(:piracy_report, seller:, product:)
      Feature.deactivate_user(:piracy_reports, seller)
      log_in(seller)

      get piracy_reports_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("can_report" => false)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      inertia_visit piracy_reports_path

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("PiracyReports/Index")
    end

    it "lets an admin team member in", parity: true do
      member = create(:user, name: "Team Admin")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
      log_in(member)
      switch_to(membership)

      get piracy_reports_path

      expect(response).to be_successful
    end

    it "sends a support team member to the dashboard with the role in the flash", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      get piracy_reports_path

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end
  end

  describe "GET /dashboard/piracy_reports/new" do
    it "lists what keeps a seller from filing", parity: true do
      create(:piracy_report, seller:, product: create(:product, user: seller), url: "https://example.net/earlier")
      log_in(seller)

      get new_piracy_report_path(product_id: product.unique_permalink)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["product"]).to include("id" => product.unique_permalink, "name" => "Design course")
      expect(props["eligibility_errors"]).to include("The seller's payout record has no legal name to print in the notice", "The product has no successful sales")
      expect(props).to include("reports_this_month" => 1, "monthly_limit" => 5)
    end

    it "lists nothing for a seller who passes every check", parity: true do
      create(:user_compliance_info, user: seller)
      Feature.activate_user(:piracy_reports_skip_sales_checks, seller)
      log_in(seller)

      get new_piracy_report_path(product_id: product.unique_permalink)

      expect(response).to be_successful
      expect(inertia_props_of(response)["eligibility_errors"]).to eq([])
    end

    it "counts a successful sale of the product", parity: true do
      create(:free_purchase, link: product)
      log_in(seller)

      get new_piracy_report_path(product_id: product.unique_permalink)

      expect(inertia_props_of(response)["eligibility_errors"]).not_to include("The product has no successful sales")
    end

    it "names a suspended seller, an unpublished product and a collaborator", parity: true do
      create(:user_compliance_info, user: seller)
      draft = create(:product, user: seller, name: "Draft course", draft: true)
      collaborator = create(:collaborator, seller:)
      create(:product_affiliate, affiliate: collaborator, product: draft)
      seller.update_columns(user_risk_state: "suspended_for_fraud")
      log_in(seller)

      get new_piracy_report_path(product_id: draft.unique_permalink)

      errors = inertia_props_of(response)["eligibility_errors"]
      expect(errors).to include("The seller's account is suspended", "The product is not published", "The product has a collaborator")
    end

    it "sends a seller back to the products list when the product is not theirs", parity: true do
      log_in(seller)

      get new_piracy_report_path(product_id: create(:product).unique_permalink)

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Product not found")
    end

    it "sends a seller back to the products list when no product is given", parity: true do
      log_in(seller)

      get new_piracy_report_path

      expect(response).to redirect_to(products_path)
    end

    it "sends a seller without the flag to the dashboard", parity: true do
      Feature.deactivate_user(:piracy_reports, seller)
      log_in(seller)

      get new_piracy_report_path(product_id: product.unique_permalink)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end
  end

  describe "GET /dashboard/piracy_reports/:id" do
    it "shows a report waiting for the seller's signature", parity: true do
      report = create(:piracy_report, :awaiting_signature, seller:, product:)
      log_in(seller)

      get piracy_report_path(report.external_id)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["report"]).to include("id" => report.external_id, "state" => "awaiting_signature", "can_cancel" => true, "notice_text" => "Notice text")
      expect(props["confirmations"].map { _1["key"] }).to eq(PiracyReport::SIGNATURE_CONFIRMATIONS.keys)
      expect(props).to include("confirmations_version" => PiracyReport::SIGNATURE_STATEMENT_VERSION, "monthly_limit" => 5)
    end

    it "shows the history and restoration window of a counter-noticed report", parity: true do
      report = create(
        :piracy_report, :signed, seller:, product:, state: "counter_noticed", screening_verdict: "pass", screened_at: Time.utc(2026, 10, 1, 12),
        sent_at: Time.utc(2026, 10, 3, 12), delivered_at: Time.utc(2026, 10, 3, 13), counter_notice_received_on: Date.new(2026, 10, 10)
      )
      log_in(seller)

      get piracy_report_path(report.external_id)

      props = inertia_props_of(response)["report"]
      expect(props["restoration_window"]).to eq(["2026-10-23", "2026-10-29"])
      expect(props["history"].map { _1["event"] }).to eq(%w[filed confirmed signed sent delivered counter_notice])
    end

    it "shows a resolved report and a cancelled one", parity: true do
      resolved = create(:piracy_report, :signed, seller:, product:, state: "resolved", outcome: "removed", resolved_at: Time.utc(2026, 10, 5, 12), screened_at: Time.utc(2026, 10, 1, 12))
      create(:piracy_report, seller:, product:, state: "cancelled", url: "https://example.net/cancelled")
      log_in(seller)

      get piracy_report_path(resolved.external_id)

      expect(inertia_props_of(response)["report"]).to include("state" => "resolved", "outcome" => "removed", "can_cancel" => false)
    end

    it "marks a report waiting on a person", parity: true do
      report = create(:piracy_report, :screening, seller:, product:, screening_verdict: "review", screened_at: Time.utc(2026, 10, 1, 12))
      log_in(seller)

      get piracy_report_path(report.external_id)

      expect(inertia_props_of(response)["report"]).to include("waiting_on_person" => true)
    end

    it "sends a seller back to the products list for an unknown or foreign report", parity: true do
      foreign = create(:piracy_report)
      log_in(seller)

      get piracy_report_path(foreign.external_id)

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Report not found")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      report = create(:piracy_report, :awaiting_signature, seller:, product:)
      log_in(seller)

      inertia_visit piracy_report_path(report.external_id)

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("PiracyReports/Show")
    end
  end
end
