# frozen_string_literal: true

require "spec_helper"

# The writes of Api::V2::UpsellsController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the scope checks and the 404 of update and destroy; the writes
# themselves (SaveUpsellService, the soft deletes) are recorded as what Node hands back.
describe "API v2 upsell writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Upsell Seller", email: "upsell-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Base", unique_permalink: "baseprod") }
  let(:offered) { create(:product, user: seller, name: "Offered", unique_permalink: "offeredp") }
  let(:token) { api_token(seller) }
  let!(:upsell) { create(:upsell, seller:, product: offered, cross_sell: true, name: "Bundle it") }

  def change(verb, path, params = {}, options = {})
    api_call(verb, path, params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  describe "POST /upsells" do
    it "refuses a request without a token", parity: true do
      change(:post, "/upsells", { name: "New" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      change(:post, "/upsells", { name: "New" }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a cross-sell to Rails", parity: true do
      change(:post, "/upsells", { name: "Add on", cross_sell: true, text: "Add it", description: "Cheap", product_id: offered.external_id, product_ids: [product.external_id] }, as: :json)

      expect(response).to have_http_status(:ok)
    end

    it "hands an upsell that references an unknown product to Rails", parity: true do
      change(:post, "/upsells", { name: "Ghost", text: "Add it", description: "Cheap", product_id: "unknown" }, as: :json)

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "hands an upsell created through the /api prefix on the Gumroad domain to Rails", parity: true do
      change(:post, "/upsells", { name: "Prefixed", cross_sell: true, text: "Add it", description: "Cheap", product_id: offered.external_id }, as: :json, api_host: false)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "PATCH and PUT /upsells/:id" do
    it "does not find an unknown upsell", parity: true do
      change(:patch, "/upsells/unknown", { name: "Renamed" })

      expect(response.parsed_body).to eq("success" => false, "message" => "The upsell was not found.")
    end

    it "does not find the upsell of another seller", parity: true do
      other = create(:upsell, seller: create(:user, email: "other-upsell-seller@example.com"), cross_sell: true)

      change(:put, "/upsells/#{other.external_id}", { name: "Renamed" })

      expect(response.parsed_body["message"]).to eq("The upsell was not found.")
    end

    it "does not find a deleted upsell", parity: true do
      upsell.mark_deleted!

      change(:patch, "/upsells/#{upsell.external_id}", { name: "Renamed" })

      expect(response.parsed_body["message"]).to eq("The upsell was not found.")
    end

    it "does not find a content upsell", parity: true do
      upsell.is_content_upsell = true
      upsell.save!(validate: false)

      change(:put, "/upsells/#{upsell.external_id}", { name: "Renamed" })

      expect(response.parsed_body["message"]).to eq("The upsell was not found.")
    end

    it "refuses a request without a token", parity: true do
      change(:patch, "/upsells/#{upsell.external_id}", { name: "Renamed" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a PATCH to Rails", parity: true do
      change(:patch, "/upsells/#{upsell.external_id}", { name: "Renamed" })

      expect(response.parsed_body["upsell"]).to include("name" => "Renamed")
    end

    it "hands a PUT that changes the audience to Rails", parity: true do
      change(:put, "/upsells/#{upsell.external_id}", { product_ids: [product.external_id], paused: true }, as: :json)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "DELETE /upsells/:id" do
    it "does not find an unknown upsell", parity: true do
      change(:delete, "/upsells/unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The upsell was not found.")
    end

    it "does not find a deleted upsell on DELETE", parity: true do
      upsell.mark_deleted!

      change(:delete, "/upsells/#{upsell.external_id}")

      expect(response.parsed_body["message"]).to eq("The upsell was not found.")
    end

    it "hands a deletion to Rails", parity: true do
      change(:delete, "/upsells/#{upsell.external_id}")

      expect(response.parsed_body["message"]).to eq("The upsell was deleted successfully.")
      expect(upsell.reload.deleted_at).to be_present
    end

    it "hands a deletion through the /api prefix on the Gumroad domain to Rails", parity: true do
      change(:delete, "/upsells/#{upsell.external_id}", {}, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end
end
