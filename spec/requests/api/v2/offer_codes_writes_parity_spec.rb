# frozen_string_literal: true

require "spec_helper"

# The writes of Api::V2::OfferCodesController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the checks that run before the write (missing amount, unknown
# product or code, malformed validity period); a write that passes them is recorded as what Node hands back.
describe "API v2 offer code writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Offer Seller", email: "offer-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Discounted", unique_permalink: "discounted", price_cents: 1000) }
  let(:token) { api_token(seller) }
  let!(:offer_code) { create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100) }

  def create_code(params = {}, options = {})
    api_call(:post, "/products/#{options.fetch(:product_id) { product.external_id }}/offer_codes", params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  def change(verb, path, params = {}, options = {})
    api_call(verb, path, params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  describe "POST /products/:link_id/offer_codes" do
    it "refuses a request without an amount", parity: true do
      create_code({ name: "NEW" })

      expect(response.parsed_body).to include("success" => false)
      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a blank amount_off", parity: true do
      create_code({ name: "NEW", amount_off: "  " })

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a missing amount before it looks for the product", parity: true do
      create_code({ name: "NEW" }, product_id: "unknown")

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a missing amount through the /api prefix on the Gumroad domain", parity: true do
      create_code({ name: "NEW" }, api_host: false)

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "does not find an unknown product", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, product_id: "unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "does not find the product of another seller", parity: true do
      other = create(:product, user: create(:user, email: "other-offer-seller@example.com"))

      create_code({ name: "NEW", amount_off: "50" }, product_id: other.external_id)

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a valid_at that is not a timestamp", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "tomorrow" })

      expect(response.parsed_body).to eq("success" => false, "message" => "valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp without a time zone", parity: true do
      create_code({ name: "NEW", amount_off: "50", expires_at: "2099-01-01T10:00:00" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp on a day the month does not have", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-02-30T10:00:00Z" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp at hour 24", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-01-01T24:00:00Z" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a leap second", parity: true do
      create_code({ name: "NEW", amount_off: "50", expires_at: "2099-01-01T10:00:60Z" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a JSON number as a validity period", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: 5 }, as: :json)

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "names the first of two bad validity periods", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-13-01T10:00:00Z", expires_at: "later" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "hands a fixed amount code to Rails", parity: true do
      create_code({ name: "NEW", amount_off: "50" })

      expect(response.parsed_body).to include("success" => true)
      expect(product.offer_codes.pluck(:code)).to include("NEW")
    end

    it "hands a percent code to Rails", parity: true do
      create_code({ name: "HALF", offer_type: "percent", amount_off: "50" })

      expect(response.parsed_body["offer_code"]).to include("name" => "HALF", "percent_off" => 50)
    end

    it "hands a code with a validity period to Rails", parity: true do
      create_code({ name: "WINDOW", amount_off: "50", valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-02-01T10:00:00+02:00" })

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code with a null validity period to Rails", parity: true do
      create_code({ name: "OPEN", amount_off: "50", valid_at: nil, expires_at: "" }, as: :json)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a timestamp with minutes out of range to Rails", parity: true do
      create_code({ name: "ODD", amount_off: "50", valid_at: "2099-01-01T10:75:00Z" })

      expect(response).to have_http_status(:ok)
    end

    it "hands a code created through the /api prefix on the Gumroad domain to Rails", parity: true do
      create_code({ name: "PREFIX", amount_cents: "75" }, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "PATCH and PUT /offer_codes/:id" do
    it "does not find an unknown offer code", parity: true do
      change(:put, "/offer_codes/unknown", { max_purchase_count: 3 })

      expect(response.parsed_body).to eq("success" => false, "message" => "The offer_code was not found.")
    end

    it "does not find the offer code of another seller", parity: true do
      other = create(:offer_code, user: create(:user, email: "other-code-seller@example.com"), code: "OTHER")

      change(:patch, "/offer_codes/#{other.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "does not find a deleted offer code", parity: true do
      offer_code.update!(deleted_at: Time.current)

      change(:put, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "refuses an expires_at that is not a timestamp", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { expires_at: "soon" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a request without a token", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a PATCH to Rails", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 3)
    end

    it "hands a PUT that sets a validity period to Rails", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-03-01T10:00:00Z" })

      expect(response).to have_http_status(:ok)
    end

    it "hands a PUT that clears the validity period to Rails", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { valid_at: nil }, as: :json)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "PATCH, PUT and DELETE /products/:link_id/offer_codes/:id" do
    it "does not find the product", parity: true do
      change(:put, "/products/unknown/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "does not find an offer code that belongs to another product", parity: true do
      other_product = create(:product, user: seller, name: "Other", unique_permalink: "otherprod")

      change(:patch, "/products/#{other_product.external_id}/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "refuses a validity period that is not a timestamp", parity: true do
      change(:put, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { valid_at: "2099-01-01" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "hands a PATCH to Rails", parity: true do
      change(:patch, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { max_purchase_count: 7 })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 7)
    end

    it "hands a PUT of a universal code through the product to Rails", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      change(:put, "/products/#{product.external_id}/offer_codes/#{universal.external_id}", { max_purchase_count: 5 })

      expect(response).to have_http_status(:ok)
    end

    it "does not find an unknown offer code on DELETE", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The offer_code was not found.")
    end

    it "does not find the product on DELETE", parity: true do
      change(:delete, "/products/unknown/offer_codes/#{offer_code.external_id}")

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "hands a deletion that carries a malformed validity period to Rails", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { valid_at: "garbage" })

      expect(response.parsed_body["success"]).to eq(true)
      expect(offer_code.reload.deleted_at).to be_present
    end

    it "hands a deletion to Rails", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}")

      expect(response.parsed_body["message"]).to eq("The offer_code was deleted successfully.")
    end

    it "hands a deletion through the /api prefix on the Gumroad domain to Rails", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", {}, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end
end
