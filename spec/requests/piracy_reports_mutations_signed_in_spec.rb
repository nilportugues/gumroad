# frozen_string_literal: true

require "spec_helper"

# Filing, signing and cancelling a piracy report the way the Inertia page does (JSON body, X-Inertia, the CSRF token in a header),
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/piracy-reports-mutations.replay.test.ts,
# which sends the last request of each example. The signed notice carries the signing date, which the replay moves to its own day.
describe "Piracy report mutations when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Piracy Seller") }
  let(:product) { create(:product, user: seller, name: "Design course") }
  let(:client_ip) { "203.0.113.7" }
  let(:agent_error) { "Piracy reports unlock with the Agent: confirm your email, complete a payout and reach $100 in sales" }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json",
      "Referer" => "http://#{DOMAIN}/dashboard/piracy_reports", "X-Forwarded-For" => client_ip }
  end

  before { Feature.activate_user(:piracy_reports, seller) }

  def send_json(path, body = nil, headers: {}, **fields)
    token = csrf_token
    post path, params: (body || fields).to_json, headers: inertia_headers.merge("X-CSRF-Token" => token).merge(headers)
  end

  def signing_date = Time.current.utc.strftime("%B %-d, %Y")

  def make_eligible
    create(:user_compliance_info, user: seller)
    Feature.activate_user(:piracy_reports_skip_sales_checks, seller)
  end

  def every_confirmation = PiracyReport::SIGNATURE_CONFIRMATIONS.keys

  def sign_body(overrides = {})
    { signed_by_name: "Jane Doe", confirmations: every_confirmation, confirmations_version: PiracyReport::SIGNATURE_STATEMENT_VERSION }.merge(overrides)
  end

  describe "POST /dashboard/piracy_reports" do
    it "redirects a signed-out visitor to the login page", parity: true do
      post piracy_reports_path, params: { authenticity_token: csrf_token, product_id: product.unique_permalink, url: "https://example.net/pirated" }

      expect(response).to redirect_to(login_path(next: "/dashboard/piracy_reports"))
    end

    it "sends a seller back to the products list when the product is not theirs", parity: true do
      make_eligible
      log_in(seller)

      send_json(piracy_reports_path, product_id: create(:product).unique_permalink, url: "https://example.net/pirated")

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Product not found")
      expect(PiracyReport.count).to eq(0)
    end

    it "sends a seller back to the products list when no product is given", parity: true do
      log_in(seller)

      send_json(piracy_reports_path, url: "https://example.net/pirated")

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Product not found")
    end

    it "sends a seller without the flag to the dashboard", parity: true do
      Feature.deactivate_user(:piracy_reports, seller)
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end

    it "sends a support team member to the dashboard with the role in the flash", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "lists what keeps the seller from filing", parity: true do
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(response).to redirect_to(new_piracy_report_path(product_id: product.unique_permalink))
      expect(flash[:alert]).to eq("#{agent_error}, The seller's payout record has no legal name to print in the notice, and The product has no successful sales")
      expect(PiracyReport.count).to eq(0)
    end

    it "refuses a URL that is not a web address", parity: true do
      make_eligible
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "ftp://example.net/pirated")

      expect(response).to redirect_to(new_piracy_report_path(product_id: product.unique_permalink))
      expect(flash[:alert]).to eq("The URL must start with http:// or https://")
    end

    it "refuses a page hosted on Gumroad", parity: true do
      make_eligible
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://#{ROOT_DOMAIN}/l/#{product.unique_permalink}")

      expect(response).to redirect_to(new_piracy_report_path(product_id: product.unique_permalink))
      expect(flash[:alert]).to eq(PiracyReport::HOSTED_ON_GUMROAD_ERROR)
    end

    it "refuses a page already reported for the product, whatever its spelling", parity: true do
      make_eligible
      create(:piracy_report, seller:, product:, url: "https://example.net/pirated/?b=2&a=1", state: "declined")
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: " http://www.example.net/pirated?a=1&b=2 ")

      expect(response).to redirect_to(new_piracy_report_path(product_id: product.unique_permalink))
      expect(flash[:alert]).to eq("This page has already been reported for this product")
    end

    it "refuses the sixth report of the month", parity: true do
      make_eligible
      PiracyReport::MONTHLY_LIMIT.times { |index| create(:piracy_report, seller:, product:, url: "https://example.net/earlier-#{index}") }
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(response).to redirect_to(new_piracy_report_path(product_id: product.unique_permalink))
      expect(flash[:alert]).to eq("The monthly limit of 5 reports has been reached")
    end

    it "lists every reason at once, in the order the service finds them", parity: true do
      create(:piracy_report, seller:, product:, url: "https://example.net/pirated", state: "declined")
      (PiracyReport::MONTHLY_LIMIT - 1).times { |index| create(:piracy_report, seller:, product:, url: "https://example.net/earlier-#{index}") }
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(flash[:alert]).to eq(
        "#{agent_error}, The seller's payout record has no legal name to print in the notice, The product has no successful sales, " \
        "This page has already been reported for this product, and The monthly limit of 5 reports has been reached"
      )
    end

    it "hands a valid report to Rails, which draws its external id", parity: true do
      make_eligible
      log_in(seller)

      send_json(piracy_reports_path, product_id: product.unique_permalink, url: "https://example.net/pirated")

      expect(response).to have_http_status(:found)
      expect(response.location).to match(%r{/dashboard/piracy_reports/[\w-]{21}\z})
      expect(PiracyReport.last).to have_attributes(seller_id: seller.id, product_id: product.id, url: "https://example.net/pirated", source: "dashboard", state: "requested")
    end
  end

  describe "POST /dashboard/piracy_reports/:id/sign" do
    let!(:report) { create(:piracy_report, :awaiting_signature, seller:, product:) }

    it "records the signature and puts it in the notice text", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(response).to redirect_to(piracy_report_path(report.external_id))
      expect(flash[:notice]).to eq("Signed. We will send the notice.")
      expect(report.reload).to have_attributes(
        state: "signed", signed_by_name: "Jane Doe", signed_ip: client_ip, signature_statement_version: PiracyReport::SIGNATURE_STATEMENT_VERSION,
        notice_text: "Notice text\n\nSigned: /s/ Jane Doe, #{signing_date}\n"
      )
      expect(report.notice_digest).to eq(Digest::SHA256.hexdigest(report.notice_text))
    end

    it "tidies the typed name: no invisible characters, one space between words", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(signed_by_name: "  Jane​   Q.\tDoe\n"))

      expect(report.reload.signed_by_name).to eq("Jane Q. Doe")
    end

    it "keeps the trailing whitespace of the notice out of the signed text", parity: true do
      report.update!(notice_text: "Notice text with a trailing newline\n\n  ")
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(report.reload.notice_text).to eq("Notice text with a trailing newline\n\nSigned: /s/ Jane Doe, #{signing_date}\n")
    end

    it "answers a single confirmation sent as text, as Rails does", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(confirmations: "details_shared"))

      expect(response).to redirect_to(piracy_report_path(report.external_id))
      expect(flash[:alert]).to eq("Check every confirmation to sign")
      expect(report.reload.state).to eq("awaiting_signature")
    end

    it "asks for every confirmation", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(confirmations: every_confirmation.first(4)))

      expect(flash[:alert]).to eq("Check every confirmation to sign")
      expect(report.reload).to have_attributes(state: "awaiting_signature", signed_by_name: nil)
    end

    it "asks for a name", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(signed_by_name: " ​ "))

      expect(flash[:alert]).to eq("Signed by name must be your full legal name")
    end

    it "refuses a name longer than 255 characters", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(signed_by_name: "あ" * 256))

      expect(flash[:alert]).to eq("Signed by name is too long")
    end

    it "lists every problem at once", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), { signed_by_name: "", confirmations_version: "2020-01-01" })

      expect(flash[:alert]).to eq(
        "Check every confirmation to sign, The confirmations changed. Reload the page and read them again., and Signed by name must be your full legal name"
      )
    end

    it "refuses a signature when the confirmations changed since the page loaded", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(confirmations_version: "2020-01-01"))

      expect(flash[:alert]).to eq("The confirmations changed. Reload the page and read them again.")
      expect(report.reload.state).to eq("awaiting_signature")
    end

    it "refuses a report that is not waiting for a signature", parity: true do
      report.update!(state: "signed", signed_by_name: "Jane Doe")
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(signed_by_name: "Someone Else"))

      expect(flash[:alert]).to eq("This report is not ready to sign")
      expect(report.reload.signed_by_name).to eq("Jane Doe")
    end

    it "refuses a report whose notice has not been generated", parity: true do
      report.update!(notice_text: nil)
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(flash[:alert]).to eq("The notice has not been generated yet")
    end

    it "sends a seller back to the products list for an unknown or foreign report", parity: true do
      foreign = create(:piracy_report, :awaiting_signature)
      log_in(seller)

      send_json(sign_piracy_report_path(foreign.external_id), sign_body)

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Report not found")
      expect(foreign.reload.state).to eq("awaiting_signature")
    end

    it "sends a support team member to the dashboard with the role in the flash", parity: true do
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
      expect(report.reload.state).to eq("awaiting_signature")
    end

    it "lets an admin team member sign", parity: true do
      member = create(:user, name: "Team Admin")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
      log_in(member)
      switch_to(membership)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(flash[:notice]).to eq("Signed. We will send the notice.")
      expect(report.reload.state).to eq("signed")
    end

    it "hands a report with a name that is not text to Rails", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body(signed_by_name: ["Jane Doe"]))

      expect(response).to redirect_to(piracy_report_path(report.external_id))
    end

    it "hands a request without a client address to Rails", parity: true do
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body, headers: { "X-Forwarded-For" => nil })

      expect(response).to redirect_to(piracy_report_path(report.external_id))
      expect(report.reload).to have_attributes(state: "signed", signed_ip: "127.0.0.1")
    end

    it "hands a report whose address the model would refuse to save to Rails", parity: true do
      report.update_columns(url: "https://example.net/a?u=https://example.org/b")
      log_in(seller)

      send_json(sign_piracy_report_path(report.external_id), sign_body)

      expect(response).to have_http_status(:found)
    end
  end

  describe "POST /dashboard/piracy_reports/:id/cancel" do
    it "cancels a report waiting for a signature", parity: true do
      report = create(:piracy_report, :awaiting_signature, seller:, product:)
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(response).to redirect_to(piracy_report_path(report.external_id))
      expect(flash[:notice]).to eq("Report cancelled. Nothing was sent.")
      expect(report.reload.state).to eq("cancelled")
    end

    it "cancels a signed report", parity: true do
      report = create(:piracy_report, :signed, seller:, product:)
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:notice]).to eq("Report cancelled. Nothing was sent.")
      expect(report.reload.state).to eq("cancelled")
    end

    it "cancels a report that is still being screened", parity: true do
      report = create(:piracy_report, :screening, seller:, product:)
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(report.reload.state).to eq("cancelled")
    end

    it "answers success again for a report a second tab already cancelled", parity: true do
      report = create(:piracy_report, seller:, product:, state: "cancelled")
      updated_at = report.updated_at
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:notice]).to eq("Report cancelled. Nothing was sent.")
      expect(report.reload.updated_at).to eq(updated_at)
    end

    it "explains that a declined report was never sent", parity: true do
      report = create(:piracy_report, seller:, product:, state: "declined")
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:alert]).to eq("We did not send this report, so there is nothing to cancel.")
      expect(report.reload.state).to eq("declined")
    end

    it "refuses to cancel a notice that was already sent", parity: true do
      report = create(:piracy_report, :signed, seller:, product:, state: "sent", sent_at: Time.current)
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:alert]).to eq("This notice was already sent, so the report cannot be cancelled.")
      expect(report.reload.state).to eq("sent")
    end

    it "refuses to cancel a resolved report", parity: true do
      report = create(:piracy_report, :signed, seller:, product:, state: "resolved", outcome: "removed")
      log_in(seller)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:alert]).to eq("This notice was already sent, so the report cannot be cancelled.")
    end

    it "sends a seller back to the products list for an unknown or foreign report", parity: true do
      foreign = create(:piracy_report, :awaiting_signature)
      log_in(seller)

      send_json(cancel_piracy_report_path(foreign.external_id))

      expect(response).to redirect_to(products_path)
      expect(flash[:alert]).to eq("Report not found")
      expect(foreign.reload.state).to eq("awaiting_signature")
    end

    it "sends a support team member to the dashboard with the role in the flash", parity: true do
      report = create(:piracy_report, :awaiting_signature, seller:, product:)
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      send_json(cancel_piracy_report_path(report.external_id))

      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
      expect(report.reload.state).to eq("awaiting_signature")
    end

    it "redirects a signed-out visitor to the login page", parity: true do
      report = create(:piracy_report, :awaiting_signature, seller:, product:)

      post cancel_piracy_report_path(report.external_id), params: { authenticity_token: csrf_token }

      expect(response).to redirect_to(login_path(next: "/dashboard/piracy_reports/#{report.external_id}/cancel"))
    end
  end
end
