# frozen_string_literal: true

require "spec_helper"

# Api::V2::BundleContentsController#update, Api::V2::CoversController, Api::V2::LinksController#enable and #edit_custom_html, recorded for
# the Next.js port (nextjs/parity/__tests__/api-v2-products.replay.test.ts). Node answers the before_actions and the refusals that come
# before a write; an example named "hands a ... back to Rails" records what it passes on whole.
describe "API v2 bundle contents, covers, enable and custom HTML edit", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let(:product) { create(:product, user: seller, description: "des", created_at: Time.current) }
  let(:bundle) { create(:product, :bundle, user: seller, created_at: Time.current) }

  describe "PUT bundle_contents" do
    let(:path) { "/products/#{bundle.external_id}/bundle_contents" }

    it "refuses a read-only token", parity: true do
      api_call(:put, path, token: api_token(seller, scopes: "view_public"), params: { products: [] })

      expect(response).to have_http_status(:forbidden)
    end

    it "says the product was not found", parity: true do
      api_call(:put, "/products/missing/bundle_contents", token:, params: { products: [] })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "does not find another seller's product", parity: true do
      other = create(:product, :bundle, user: create(:user))

      api_call(:put, "/products/#{other.external_id}/bundle_contents", token:, params: { products: [] }, api_host: false)

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "refuses a product that is not a bundle", parity: true do
      api_call(:put, "/products/#{product.external_id}/bundle_contents", token:, params: { products: [] })

      expect(response.parsed_body["message"]).to eq("This product is not a bundle.")
    end

    it "refuses a quantity of zero", parity: true do
      api_call(:put, path, token:, params: { products: [{ product_id: bundle.bundle_products.first.product.external_id, quantity: 0 }] }, as: :json)

      expect(response.parsed_body["message"]).to eq("Quantity must be an integer greater than 0.")
    end

    it "refuses a quantity that is not a number", parity: true do
      api_call(:put, path, token:, params: { products: [{ product_id: bundle.bundle_products.first.product.external_id, quantity: "many" }] }, as: :json)

      expect(response.parsed_body["message"]).to eq("Quantity must be an integer greater than 0.")
    end

    it "refuses a quantity above the integer limit", parity: true do
      api_call(:put, path, token:, params: { products: [{ product_id: bundle.bundle_products.first.product.external_id, quantity: 2_147_483_648 }] }, as: :json)

      expect(response.parsed_body["message"]).to eq("Quantity must be an integer greater than 0.")
    end

    it "refuses a position that is not a number", parity: true do
      api_call(:put, path, token:, params: { products: [{ product_id: bundle.bundle_products.first.product.external_id, position: "first" }] }, as: :json)

      expect(response.parsed_body["message"]).to eq("Position must be a valid integer.")
    end

    it "reports the first product that fails", parity: true do
      id = bundle.bundle_products.first.product.external_id
      api_call(:put, path, token:, params: { products: [{ product_id: id, quantity: 1 }, { product_id: id, quantity: -1 }, { product_id: id, position: "x" }] }, as: :json)

      expect(response.parsed_body["message"]).to eq("Quantity must be an integer greater than 0.")
    end

    it "hands a bundle replacement back to Rails", parity: true do
      first = bundle.bundle_products.first.product
      api_call(:put, path, token:, params: { products: [{ product_id: first.external_id, quantity: 3 }] }, as: :json)

      expect(response.parsed_body["success"]).to eq(true)
      expect(bundle.reload.bundle_products.alive.map(&:product)).to contain_exactly(first)
    end

    it "hands a products string back to Rails", parity: true do
      api_call(:put, path, token:, params: { products: "everything" }, as: :json)

      expect(response.parsed_body["success"]).to eq(false)
      expect(response.parsed_body["message"]).to be_present
    end
  end

  describe "POST covers" do
    it "refuses a read-only token", parity: true do
      api_call(:post, "/products/#{product.external_id}/covers", token: api_token(seller, scopes: "view_public"), params: { url: "https://example.com/a.png" })

      expect(response).to have_http_status(:forbidden)
    end

    it "says the product was not found", parity: true do
      api_call(:post, "/products/missing/covers", token:, params: { url: "https://example.com/a.png" })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "asks for a signed_blob_id or url", parity: true do
      api_call(:post, "/products/#{product.external_id}/covers", token:)

      expect(response.parsed_body["message"]).to eq("Please provide a signed_blob_id or url.")
    end

    it "treats a blank url as missing", parity: true do
      api_call(:post, "/products/#{product.external_id}/covers", token:, params: { url: "  " }, api_host: false)

      expect(response.parsed_body["message"]).to eq("Please provide a signed_blob_id or url.")
    end

    it "refuses a signed_blob_id that is not text", parity: true do
      api_call(:post, "/products/#{product.external_id}/covers", token:, params: { signed_blob_id: 5 }, as: :json)

      expect(response.parsed_body["message"]).to eq("The signed_blob_id is invalid or expired.")
    end

    it "hands a signed_blob_id back to Rails", parity: true do
      api_call(:post, "/products/#{product.external_id}/covers", token:, params: { signed_blob_id: "not-a-signed-id" })

      expect(response.parsed_body["message"]).to eq("The signed_blob_id is invalid or expired.")
    end
  end

  describe "DELETE covers" do
    let!(:cover) { create(:asset_preview, link: product, attach: false, unsplash_url: "https://images.example.com/photo.jpg") }

    it "refuses a read-only token", parity: true do
      api_call(:delete, "/products/#{product.external_id}/covers/#{cover.guid}", token: api_token(seller, scopes: "view_public"))

      expect(response).to have_http_status(:forbidden)
    end

    it "says the cover was not found", parity: true do
      api_call(:delete, "/products/#{product.external_id}/covers/missing", token:)

      expect(response.parsed_body["message"]).to eq("The cover was not found.")
    end

    it "does not find the cover of another product", parity: true do
      other = create(:product, user: seller)

      api_call(:delete, "/products/#{other.external_id}/covers/#{cover.guid}", token:, api_host: false)

      expect(response.parsed_body["message"]).to eq("The cover was not found.")
    end

    it "does not find a cover that is already deleted", parity: true do
      cover.update_columns(deleted_at: 1.day.ago)

      api_call(:delete, "/products/#{product.external_id}/covers/#{cover.guid}", token:)

      expect(response.parsed_body["message"]).to eq("The cover was not found.")
    end

    it "hands the delete of a live cover back to Rails", parity: true do
      api_call(:delete, "/products/#{product.external_id}/covers/#{cover.guid}", token:)

      expect(response.parsed_body["success"]).to eq(true)
      expect(cover.reload.deleted_at).to be_present
    end
  end

  describe "PUT enable" do
    it "refuses a read-only token", parity: true do
      api_call(:put, "/products/#{product.external_id}/enable", token: api_token(seller, scopes: "view_public"))

      expect(response).to have_http_status(:forbidden)
    end

    it "says the product was not found", parity: true do
      api_call(:put, "/products/missing/enable", token:)

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "does not find another seller's product", parity: true do
      other = create(:product, user: create(:user))

      api_call(:put, "/products/#{other.external_id}/enable", token:, api_host: false)

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end
  end

  describe "POST custom_html/edit" do
    let(:path) { "/products/#{product.external_id}/custom_html/edit" }

    before { Feature.activate_user(:custom_html_pages, seller) }

    it "refuses a read-only token", parity: true do
      api_call(:post, path, token: api_token(seller, scopes: "view_public"), params: { find: "a", replace: "b" })

      expect(response).to have_http_status(:forbidden)
    end

    it "says the product was not found", parity: true do
      api_call(:post, "/products/missing/custom_html/edit", token:, params: { find: "a", replace: "b" })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "refuses a seller without custom HTML pages", parity: true do
      Feature.deactivate_user(:custom_html_pages, seller)

      api_call(:post, path, token:, params: { find: "a", replace: "b" })

      expect(response.parsed_body["message"]).to eq("You do not have access to custom HTML pages.")
    end

    it "asks for a find snippet", parity: true do
      api_call(:post, path, token:, params: { replace: "b" })

      expect(response.parsed_body["message"]).to start_with("find is required")
    end

    it "treats a blank find snippet as missing", parity: true do
      api_call(:post, path, token:, params: { find: "   ", replace: "b" }, api_host: false)

      expect(response.parsed_body["message"]).to start_with("find is required")
    end

    it "asks for a replace string", parity: true do
      api_call(:post, path, token:, params: { find: "a" })

      expect(response.parsed_body["message"]).to start_with("replace is required")
    end

    it "hands an edit back to Rails", parity: true do
      product.update!(custom_html: "<div data-gumroad-action=\"buy\">Buy now</div>")

      api_call(:post, path, token:, params: { find: "Buy now", replace: "Buy" }, as: :json)

      expect(response.parsed_body["success"]).to eq(true)
      expect(product.reload.custom_html).to include("Buy</div>")
    end
  end
end
