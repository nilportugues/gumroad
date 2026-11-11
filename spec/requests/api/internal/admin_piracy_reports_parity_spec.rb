# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::PiracyReportsController through the whole stack, on the API host with a per-actor piracy token. Recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are
# requests the port leaves to Rails (they mail the seller or need the notice rendered): the replay asserts they reach the stand-in
# Rails untouched and write nothing. The earned-access bar is an Elasticsearch aggregation, so eligible sellers carry the skip flag.
describe "Internal admin API piracy reports", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer piracy-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com", name: "Piracy Seller") }
  let(:product) { create(:product, user: seller, name: "Design course", description: "<p>Learn <strong>design</strong></p>\n<p>fast</p>") }

  before do
    create(:admin_api_token, actor_user: admin, scope: AdminApiToken::PIRACY_SCOPE, token_hash: AdminApiToken.hash_token("piracy-token"))
    create(:user_compliance_info, user: seller)
    Feature.activate_user(:piracy_reports, seller)
    Feature.activate_user(:piracy_reports_skip_sales_checks, seller)
  end

  def sell(link)
    build(:purchase, link:, seller: link.user, purchase_state: "successful", created_at: 2.days.ago).save!(validate: false)
  end

  describe "GET show" do
    it "reads a report with the product facts, files and eligibility", parity: true do
      sell(product)
      create(:product_file, link: product, display_name: "Course.pdf", size: 2048)
      report = create(:piracy_report, :screening, seller:, product:, screening_verdict: "review", screening_checks: { "agent" => { "page_offers_work" => { "passed" => true, "reason" => "Same course." } } }, screened_at: 1.hour.ago)

      get "/internal/admin/piracy_reports/#{report.external_id}", headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]).to include("needs_review" => true, "eligibility_errors" => [])
      expect(response.parsed_body["report"]["product"]).to include("successful_sales_count" => 1, "description" => "Learn design fast")
    end

    it "lists the reasons a seller is no longer eligible", parity: true do
      report = create(:piracy_report, seller:, product:)
      Feature.deactivate_user(:piracy_reports, seller)
      Feature.deactivate_user(:piracy_reports_skip_sales_checks, seller)

      get "/internal/admin/piracy_reports/#{report.external_id}", headers: headers

      expect(response.parsed_body["report"]["eligibility_errors"]).to include("Piracy reports are not enabled for this seller", "The product has no successful sales")
    end

    it "returns 404 for an unknown report", parity: true do
      get "/internal/admin/piracy_reports/unknown", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a product description with an entity to Rails", parity: true do
      product.update_columns(description: "<p>Fish &amp; chips</p>")
      report = create(:piracy_report, seller:, product:)

      get "/internal/admin/piracy_reports/#{report.external_id}", headers: headers

      expect(response.parsed_body["report"]["product"]["description"]).to eq("Fish &amp; chips")
    end
  end

  describe "POST create" do
    let(:params) { { user_id: seller.external_id, product_id: product.external_id, url: "https://example.net/design-course", ticket_url: "https://helper.example.com/tickets/1" } }

    it "files a support report and audits the write", parity: true do
      sell(product)

      post "/internal/admin/piracy_reports", params:, headers: headers

      expect(response).to have_http_status(:created)
      expect(response.parsed_body["report"]).to include("state" => "requested", "source" => "support", "ticket_url" => "https://helper.example.com/tickets/1")
    end

    it "returns 400 without a user_id", parity: true do
      post "/internal/admin/piracy_reports", params: params.except(:user_id), headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "returns 404 for a product that is not the seller's", parity: true do
      post "/internal/admin/piracy_reports", params: params.merge(product_id: create(:product).external_id), headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "returns 422 with the reasons when the seller is not eligible", parity: true do
      Feature.deactivate_user(:piracy_reports, seller)

      post "/internal/admin/piracy_reports", params:, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["Piracy reports are not enabled for this seller"])
    end

    it "returns 422 for a page already reported under another spelling of its URL", parity: true do
      sell(product)
      create(:piracy_report, seller:, product:, url: "https://example.net/design-course")

      post "/internal/admin/piracy_reports", params: params.merge(url: "HTTPS://www.Example.net/design-course/#top"), headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["This page has already been reported for this product"])
    end

    it "returns 422 for a page hosted on Gumroad", parity: true do
      sell(product)

      post "/internal/admin/piracy_reports", params: params.merge(url: "https://#{ROOT_DOMAIN.split(":").first}/l/elsewhere"), headers: headers

      expect(response.parsed_body["errors"]).to eq([PiracyReport::HOSTED_ON_GUMROAD_ERROR])
    end

    it "returns 422 for a URL that is not http", parity: true do
      sell(product)

      post "/internal/admin/piracy_reports", params: params.merge(url: "ftp://example.net/course"), headers: headers

      expect(response.parsed_body["errors"]).to eq(["The URL must start with http:// or https://"])
    end

    it "returns 422 when the monthly limit is reached", parity: true do
      sell(product)
      PiracyReport::MONTHLY_LIMIT.times { |index| create(:piracy_report, seller:, product:, url: "https://example.net/copy-#{index}") }

      post "/internal/admin/piracy_reports", params:, headers: headers

      expect(response.parsed_body["errors"]).to eq(["The monthly limit of 5 reports has been reached"])
    end

    it "hands a URL with credentials to Rails", parity: true do
      sell(product)

      post "/internal/admin/piracy_reports", params: params.merge(url: "https://user@example.net/course"), headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end

  describe "POST start_screening" do
    it "moves a requested report to screening", parity: true do
      report = create(:piracy_report, seller:, product:)

      post "/internal/admin/piracy_reports/#{report.external_id}/start_screening", headers: headers

      expect(response).to have_http_status(:ok)
      expect(report.reload.state).to eq("screening")
    end

    it "returns 422 for a report that is already being screened", parity: true do
      report = create(:piracy_report, :screening, seller:, product:)

      post "/internal/admin/piracy_reports/#{report.external_id}/start_screening", headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to include("Cannot transition state via :start_screening from :screening")
    end

    it "returns 404 for an unknown report", parity: true do
      post "/internal/admin/piracy_reports/unknown/start_screening", headers: headers

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST screen" do
    let(:report) { create(:piracy_report, :screening, seller:, product:) }
    let(:checks) { PiracyReport::SCREENING_CHECKS.index_with { { passed: true, reason: "Matches the product." } } }

    before { sell(product) }

    it "declines the report on a fail verdict", parity: true do
      post "/internal/admin/piracy_reports/#{report.external_id}/screen", params: { verdict: "fail", checks: { page_offers_work: { passed: false, reason: "Different course." } } }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]).to include("state" => "declined", "screening_verdict" => "fail")
    end

    it "flags the report for review on a review verdict", parity: true do
      post "/internal/admin/piracy_reports/#{report.external_id}/screen", params: { verdict: "review", checks: { not_other_authorized_use: { passed: "true", reason: "Looks like a review." }, page_offers_work: { passed: false, reason: "Unclear." } } }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]).to include("state" => "screening", "needs_review" => true)
    end

    it "returns 422 with the errors for invalid input", parity: true do
      post "/internal/admin/piracy_reports/#{report.external_id}/screen", params: { verdict: "pass", checks: checks.merge("page_offers_work" => { passed: "maybe", reason: "r" }) }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to include("check page_offers_work passed must be true or false")
    end

    it "returns 422 when the report is not being screened", parity: true do
      requested = create(:piracy_report, seller:, product:, url: "https://example.net/other")

      post "/internal/admin/piracy_reports/#{requested.external_id}/screen", params: { verdict: "review", checks: { page_offers_work: { passed: true, reason: "r" } } }, headers: headers

      expect(response.parsed_body["message"]).to eq("The report is not being screened")
    end

    it "hands a pass verdict to Rails", parity: true do
      entry = PiracyReports::RecipientRegistry::Entry.new(name: "Example Net Inc.", email: "copyright@example.net", source_url: "https://dmca.copyright.gov/osp/example")
      allow(PiracyReports::RecipientRegistry).to receive(:entries).and_return("example.net" => entry)

      post "/internal/admin/piracy_reports/#{report.external_id}/screen", params: { verdict: "pass", checks: }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]["state"]).to eq("awaiting_signature")
    end
  end

  describe "POST counter_notice" do
    let(:sent) { create(:piracy_report, :signed, seller:, product:, state: "sent", sent_at: 3000.days.ago) }

    it "returns 422 for a report with no notice out", parity: true do
      report = create(:piracy_report, :signed, seller:, product:)

      post "/internal/admin/piracy_reports/#{report.external_id}/counter_notice", params: { body: "x", received_on: Date.yesterday.iso8601 }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["The report has no notice out with a host"])
    end

    it "returns 422 for a blank body and a date in the future", parity: true do
      post "/internal/admin/piracy_reports/#{sent.external_id}/counter_notice", params: { body: "  ", received_on: 1.year.from_now.to_date.iso8601 }, headers: headers

      expect(response.parsed_body["errors"]).to eq(["body is required", "received_on must be a YYYY-MM-DD date between the send date and today"])
    end

    it "returns 422 when a counter-notice is already recorded", parity: true do
      sent.update_columns(counter_notice_body: "Earlier notice.")

      post "/internal/admin/piracy_reports/#{sent.external_id}/counter_notice", params: { body: "Again", received_on: Date.yesterday.iso8601 }, headers: headers

      expect(response.parsed_body["errors"]).to eq(["A counter-notice is already recorded for this report"])
    end

    it "hands a counter-notice that is accepted to Rails", parity: true do
      post "/internal/admin/piracy_reports/#{sent.external_id}/counter_notice", params: { body: "I own a license.", received_on: Date.yesterday.iso8601 }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]).to include("state" => "counter_noticed")
    end
  end

  describe "POST resolve" do
    let(:sent) { create(:piracy_report, :signed, seller:, product:, state: "sent", sent_at: 3000.days.ago) }

    it "returns 422 for a restored outcome without a counter-notice", parity: true do
      post "/internal/admin/piracy_reports/#{sent.external_id}/resolve", params: { outcome: "restored" }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["restored needs a recorded counter-notice"])
    end

    it "returns 422 for a withdrawn outcome without a reason", parity: true do
      post "/internal/admin/piracy_reports/#{sent.external_id}/resolve", params: { outcome: "withdrawn" }, headers: headers

      expect(response.parsed_body["errors"]).to eq(["a withdrawn report needs a reason"])
    end

    it "returns 422 for a report that already has an outcome", parity: true do
      sent.update_columns(state: "resolved", outcome: "removed", outcome_notified_at: Time.current)

      post "/internal/admin/piracy_reports/#{sent.external_id}/resolve", params: { outcome: "no_response" }, headers: headers

      expect(response.parsed_body["errors"]).to eq(["The report already has an outcome"])
    end

    it "hands a resolve outcome that is accepted to Rails", parity: true do
      post "/internal/admin/piracy_reports/#{sent.external_id}/resolve", params: { outcome: "removed" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["report"]).to include("state" => "resolved", "outcome" => "removed")
    end
  end
end
