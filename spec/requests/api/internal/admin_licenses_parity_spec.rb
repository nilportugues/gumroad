# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::LicensesController through the whole stack, on the API host with an admin token. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are requests the
# port leaves to Rails (a purchase charged through Stripe needs its Radar risk level, a license key that is not text): the replay asserts
# they reach the stand-in Rails untouched and write nothing.
describe "Internal admin API licenses", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com", name: "Seller Name") }
  let(:product) { create(:product, user: seller, name: "Licensed product", price_cents: 1500) }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  def create_purchase(**attributes)
    defaults = { seller:, link: product, email: "buyer@example.com", price_cents: 1500, purchase_state: "successful", charge_processor_id: "paypal", stripe_transaction_id: "PAYPAL-TXN-1", merchant_account: nil, created_at: 3.days.ago }
    build(:purchase, **defaults, **attributes).tap { _1.save!(validate: false) }
  end

  describe "GET lookup" do
    it "returns the license, its purchase and the activation count", parity: true do
      license = create(:license, link: product, purchase: create_purchase, uses: 3)

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "uses" => 3)
      expect(response.parsed_body["license"]).to include("email" => "buyer@example.com", "product_name" => "Licensed product", "enabled" => true, "disabled" => false, "uses" => 3)
      expect(response.parsed_body.dig("purchase", "email")).to eq("buyer@example.com")
    end

    it "reports a disabled license", parity: true do
      license = create(:license, link: product, purchase: create_purchase)
      license.update_column(:disabled_at, 1.day.ago)

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial }, headers: headers

      expect(response.parsed_body["license"]).to include("enabled" => false, "disabled" => true)
    end

    it "takes the product from the purchase when the license has none", parity: true do
      license = create(:license, link: nil, purchase: create_purchase)

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial }, headers: headers

      expect(response.parsed_body["license"]).to include("product_name" => "Licensed product")
    end

    it "returns a license that has no purchase", parity: true do
      license = create(:license, link: product, purchase: nil, uses: 1)

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("purchase" => nil, "uses" => 1)
      expect(response.parsed_body["license"]).to include("email" => nil, "purchase_id" => nil, "product_name" => "Licensed product")
    end

    it "finds the license whatever the case of the key", parity: true do
      license = create(:license, link: product, purchase: create_purchase)

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial.downcase }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "returns a bad request when the license key is missing", parity: true do
      get "/internal/admin/licenses/lookup", headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "message" => "license_key is required")
    end

    it "returns a bad request when the license key is blank", parity: true do
      get "/internal/admin/licenses/lookup", params: { license_key: "  " }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "returns not found when no license has the key", parity: true do
      get "/internal/admin/licenses/lookup", params: { license_key: "missing-key" }, headers: headers

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "License not found")
    end

    it "refuses a request without credentials", parity: true do
      get "/internal/admin/licenses/lookup", params: { license_key: "any" }, headers: { "Host" => API_DOMAIN }

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a license of a purchase charged through Stripe to Rails", parity: true do
      license = create(:license, link: product, purchase: create_purchase(charge_processor_id: "stripe", stripe_transaction_id: "ch_stripe_1"))
      allow(Radar::ChargeRiskLevelService).to receive(:fetch).and_return("normal")

      get "/internal/admin/licenses/lookup", params: { license_key: license.serial }, headers: headers

      expect(response.parsed_body.dig("purchase", "stripe_risk_level")).to eq("normal")
    end

    it "hands a list of license keys to Rails", parity: true do
      license = create(:license, link: product, purchase: create_purchase)

      get "/internal/admin/licenses/lookup", params: { license_key: [license.serial] }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end
end
