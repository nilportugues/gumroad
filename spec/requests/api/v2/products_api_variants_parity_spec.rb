# frozen_string_literal: true

require "spec_helper"

# The v2 API's writes to a category's versions (Api::V2::VariantsController#create, #update and #destroy), recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts). Node answers the lookups that fail and the delete of a version that is
# already deleted; an example named "hands a ... back to Rails" records what it passes on whole.
describe "API v2 version writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, description: "des", created_at: Time.current) }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let!(:category) { create(:variant_category, link: product, title: "Size") }
  let!(:variant) { create(:variant, variant_category: category, name: "Small", price_difference_cents: 0) }

  def variants_path(suffix = "", category_id: category.external_id, product_id: product.external_id)
    "/products/#{product_id}/variant_categories/#{category_id}/variants#{suffix}"
  end

  describe "POST create" do
    it "refuses a read-only token", parity: true do
      api_call(:post, variants_path, token: api_token(seller, scopes: "view_public"), params: { name: "Large" })

      expect(response).to have_http_status(:forbidden)
    end

    it "says the product was not found", parity: true do
      api_call(:post, variants_path(product_id: "missing"), token:, params: { name: "Large" })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "does not find another seller's product", parity: true do
      other = create(:product, user: create(:user))

      api_call(:post, variants_path(product_id: other.external_id), token:, params: { name: "Large" }, api_host: false)

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "says the variant category was not found", parity: true do
      api_call(:post, variants_path(category_id: "missing"), token:, params: { name: "Large" })

      expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
    end

    it "does not find another product's variant category", parity: true do
      other_category = create(:variant_category, link: create(:product, user: seller), title: "Colour")

      api_call(:post, variants_path(category_id: other_category.external_id), token:, params: { name: "Large" })

      expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
    end

    it "hands a version create back to Rails", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", price_difference_cents: "250" })

      expect(response.parsed_body["variant"]).to include("name" => "Large", "price_difference_cents" => 250)
      expect(category.variants.reload.map(&:name)).to contain_exactly("Small", "Large")
    end
  end

  describe "PUT update" do
    it "says the variant was not found", parity: true do
      api_call(:put, variants_path("/missing"), token:, params: { name: "Large" })

      expect(response.parsed_body["message"]).to eq("The variant was not found.")
    end

    it "does not find a version of another category", parity: true do
      other_category = create(:variant_category, link: product, title: "Colour")
      other = create(:variant, variant_category: other_category, name: "Red")

      api_call(:patch, variants_path("/#{other.external_id}"), token:, params: { name: "Large" }, api_host: false)

      expect(response.parsed_body["message"]).to eq("The variant was not found.")
    end

    it "refuses a read-only token", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token: api_token(seller, scopes: "view_public"), params: { name: "Large" })

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a version update back to Rails", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { name: "Large" })

      expect(response.parsed_body["variant"]["name"]).to eq("Large")
      expect(variant.reload.name).to eq("Large")
    end

    it "hands a version patch back to Rails", parity: true do
      api_call(:patch, variants_path("/#{variant.external_id}"), token:, params: { description: "Roomy" }, api_host: false)

      expect(variant.reload.description).to eq("Roomy")
    end
  end

  describe "DELETE destroy" do
    it "says the variant was not found", parity: true do
      api_call(:delete, variants_path("/missing"), token:)

      expect(response.parsed_body["message"]).to eq("The variant was not found.")
    end

    it "says the variant category was not found", parity: true do
      api_call(:delete, variants_path("/#{variant.external_id}", category_id: "missing"), token:)

      expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
    end

    it "reports success for a version that is already deleted and records no second deletion", parity: true do
      variant.update_columns(deleted_at: Time.utc(2025, 1, 1))

      api_call(:delete, variants_path("/#{variant.external_id}"), token:)

      expect(response.parsed_body["success"]).to be(true)
      expect(variant.reload.deleted_at).to eq(Time.utc(2025, 1, 1))
      expect(ProductVariantDeletionAudit.count).to eq(0)
    end

    it "reports success for a deleted version in a category that is itself deleted", parity: true do
      variant.update_columns(deleted_at: Time.utc(2025, 1, 1))
      category.update_columns(deleted_at: Time.utc(2025, 1, 2))

      api_call(:delete, variants_path("/#{variant.external_id}"), token:, api_host: false)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "hands the delete of a live version back to Rails", parity: true do
      api_call(:delete, variants_path("/#{variant.external_id}"), token:)

      expect(response.parsed_body["success"]).to be(true)
      expect(variant.reload.deleted_at).to be_present
      expect(ProductVariantDeletionAudit.count).to eq(1)
    end
  end
end
