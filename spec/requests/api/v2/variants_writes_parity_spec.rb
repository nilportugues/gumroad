# frozen_string_literal: true

require "spec_helper"

# The v2 API's writes to a category's versions (Api::V2::VariantsController#create, #update and #destroy), recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts). Node saves the versions of a plain product (no tiers, no call or coffee type,
# no prices of its own, a currency it holds a minimum for) and answers the lookups that fail; an example named "hands a ... back to Rails"
# records what it passes on whole. `parity_timeline` records the order of the statements and jobs inside each save.
describe "API v2 version writes", type: :request, parity_timeline: true do
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

    it "creates a version with a name", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large" })

      expect(response.parsed_body["variant"]).to include("name" => "Large", "price_difference_cents" => nil)
      expect(category.variants.reload.map(&:name)).to contain_exactly("Small", "Large")
    end

    it "creates a version with a price, a description and a limit", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", price_difference_cents: "250", description: "Roomy", max_purchase_count: "5" })

      expect(response.parsed_body["variant"]).to include("name" => "Large", "price_difference_cents" => 250, "description" => "Roomy", "max_purchase_count" => 5)
    end

    it "places a new version after the last one", parity: true do
      create(:variant, variant_category: category, name: "Medium", position_in_category: 4)

      api_call(:post, variants_path, token:, params: { name: "Large" }, api_host: false)

      expect(Variant.find_by(name: "Large").position_in_category).to eq(5)
    end

    it "places a new version after the first one", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large" })

      expect(Variant.find_by(name: "Large").position_in_category).to eq(1)
    end

    it "counts the versions of a category whose last version has no position", parity: true do
      create(:variant, variant_category: category, name: "Medium")
      Variant.where(variant_category: category).update_all(position_in_category: nil)

      api_call(:post, variants_path, token:, params: { name: "Large" })

      expect(Variant.find_by(name: "Large").position_in_category).to eq(2)
    end

    it "creates the first version of an empty category", parity: true do
      empty = create(:variant_category, link: product, title: "Colour")

      api_call(:post, variants_path(category_id: empty.external_id), token:, params: { name: "Red" })

      expect(Variant.find_by(name: "Red").position_in_category).to eq(0)
    end

    it "clamps a limit above the maximum", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", max_purchase_count: "99999999" })

      expect(response.parsed_body["variant"]["max_purchase_count"]).to eq(10_000_000)
    end

    it "clamps a negative limit to zero", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", max_purchase_count: "-3" })

      expect(response.parsed_body["variant"]["max_purchase_count"]).to eq(0)
    end

    it "refuses a request without a name", parity: true do
      api_call(:post, variants_path, token:, params: { price_difference_cents: "100" })

      expect(response.parsed_body["message"]).to eq("Name can't be blank")
    end

    it "refuses a blank name", parity: true do
      api_call(:post, variants_path, token:, params: { name: "   " })

      expect(response.parsed_body["message"]).to eq("Name can't be blank")
    end

    it "refuses a negative price", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", price_difference_cents: "-1" })

      expect(response.parsed_body["message"]).to eq("Please enter a price that is equal to or greater than the price of the product.")
    end

    it "accepts a price below the minimum of the currency, which only a price of the version itself is held to", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", price_difference_cents: "10" })

      expect(response.parsed_body["variant"]["price_difference_cents"]).to eq(10)
    end

    it "reads a price that is not a whole number as its leading digits", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", price_difference_cents: "250.7" })

      expect(response.parsed_body["variant"]["price_difference_cents"]).to eq(250)
    end

    it "ignores a parameter the version does not permit", parity: true do
      api_call(:post, variants_path, token:, params: { name: "Large", position_in_category: "9", deleted_at: "2020-01-01" })

      expect(response.parsed_body["variant"]["name"]).to eq("Large")
      expect(Variant.find_by(name: "Large").position_in_category).to eq(1)
    end

    it "hands a version of a tiered membership back to Rails", parity: true do
      membership = create(:membership_product, user: seller)

      api_call(:post, variants_path(product_id: membership.external_id, category_id: membership.tier_category.external_id), token:, params: { name: "Gold" })

      expect(response.parsed_body["variant"]["name"]).to eq("Gold")
    end

    it "hands a version of a call product back to Rails", parity: true do
      seller.update_columns(created_at: 60.days.ago)
      call = create(:call_product, user: seller)

      api_call(:post, variants_path(product_id: call.external_id, category_id: call.variant_categories.first.external_id), token:, params: { name: "Half hour", duration_in_minutes: "30" })

      expect(response.parsed_body["message"]).to eq("Duration in minutes is not a number")
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

    it "updates the name of a version", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { name: "Large" })

      expect(response.parsed_body["variant"]["name"]).to eq("Large")
      expect(variant.reload.name).to eq("Large")
    end

    it "updates the description of a version with a patch", parity: true do
      api_call(:patch, variants_path("/#{variant.external_id}"), token:, params: { description: "Roomy" }, api_host: false)

      expect(variant.reload.description).to eq("Roomy")
    end

    it "updates the price and the limit of a version", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { price_difference_cents: "500", max_purchase_count: "20" })

      expect(response.parsed_body["variant"]).to include("price_difference_cents" => 500, "max_purchase_count" => 20)
    end

    it "keeps a version whose request changes nothing", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { name: "Small" })

      expect(response.parsed_body["variant"]["name"]).to eq("Small")
    end

    it "keeps a version when the request names no attribute", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "clears the limit of a version with a blank value", parity: true do
      variant.update_columns(max_purchase_count: 7)

      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { max_purchase_count: "" })

      expect(response.parsed_body["variant"]["max_purchase_count"]).to be_nil
    end

    it "refuses a limit below what the version has sold", parity: true do
      variant.update_columns(sales_count_for_inventory_cache: 4)

      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { max_purchase_count: "3" })

      expect(response.parsed_body["message"]).to eq("You have chosen an amount lower than what you have already sold. Please enter an amount greater than 4.")
      expect(variant.reload.max_purchase_count).to be_nil
    end

    it "refuses a blank name", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { name: "" })

      expect(response.parsed_body["message"]).to eq("Name can't be blank")
      expect(variant.reload.name).to eq("Small")
    end

    it "refuses a negative price", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { price_difference_cents: "-5" })

      expect(response.parsed_body["message"]).to eq("Please enter a price that is equal to or greater than the price of the product.")
    end

    it "updates a deleted version as it does a live one", parity: true do
      variant.update_columns(deleted_at: Time.utc(2025, 1, 1))

      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { name: "Large" })

      expect(response.parsed_body["variant"]["name"]).to eq("Large")
    end

    it "hands a version update with rich content back to Rails", parity: true do
      api_call(:put, variants_path("/#{variant.external_id}"), token:, params: { rich_content: [].to_json })

      expect(response.parsed_body["success"]).to be(true)
    end

    it "hands a tier update back to Rails", parity: true do
      membership = create(:membership_product, user: seller)
      tier = membership.tier_category.variants.first

      api_call(:put, variants_path("/#{tier.external_id}", product_id: membership.external_id, category_id: membership.tier_category.external_id), token:, params: { name: "Gold" })

      expect(response.parsed_body["variant"]["name"]).to eq("Gold")
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

    it "deletes a live version and records the deletion", parity: true do
      api_call(:delete, variants_path("/#{variant.external_id}"), token:, headers: { "X-Request-Id" => "parity-variant-destroy" })

      expect(response.parsed_body["success"]).to be(true)
      expect(variant.reload.deleted_at).to be_present
      expect(ProductVariantDeletionAudit.count).to eq(1)
    end

    it "deletes one of two versions through the api prefix", parity: true do
      create(:variant, variant_category: category, name: "Large")

      api_call(:delete, variants_path("/#{variant.external_id}"), token:, api_host: false, headers: { "X-Request-Id" => "parity-variant-destroy" })

      expect(category.variants.alive.map(&:name)).to eq(["Large"])
    end

    it "hands a tier delete back to Rails", parity: true do
      membership = create(:membership_product, user: seller)
      tier = membership.tier_category.variants.first

      api_call(:delete, variants_path("/#{tier.external_id}", product_id: membership.external_id, category_id: membership.tier_category.external_id), token:)

      expect(response.parsed_body["success"]).to be(true)
    end
  end
end
