# frozen_string_literal: true

require "spec_helper"

# config/routes.rb still maps GET /customers/sales, POST /customers/import and POST /customers/import_manually_entered_emails to
# CustomersController actions that no longer exist. Rails raises ActionNotFound before any callback runs, so every visitor gets the
# public 404. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/customers-missing-actions.replay.test.ts.
describe "Customers routes without an action", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Missing Action Seller") }
  let(:json_headers) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  describe "GET /customers/sales" do
    it "answers 404 to a signed-out visitor", parity: true do
      get sales_paged_path, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a signed-in seller", parity: true do
      log_in(seller)

      get sales_paged_path, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /customers/import" do
    it "answers 404 to a signed-out visitor without a CSRF token", parity: true do
      post customers_import_path, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a signed-in seller", parity: true do
      log_in(seller)

      post customers_import_path, params: { authenticity_token: csrf_token }, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /customers/import_manually_entered_emails" do
    it "answers 404 to a signed-out visitor", parity: true do
      post customers_import_manually_entered_emails_path, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a signed-in seller", parity: true do
      log_in(seller)

      post customers_import_manually_entered_emails_path, params: { authenticity_token: csrf_token, emails: "a@example.com" }, headers: json_headers

      expect(response).to have_http_status(:not_found)
    end
  end
end
