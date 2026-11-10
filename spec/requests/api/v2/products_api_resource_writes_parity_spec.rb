# frozen_string_literal: true

require "spec_helper"

# The v2 API's writes to a product's custom fields and variant categories, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts).
describe "API v2 product resource writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, description: "des", created_at: Time.current) }
  let(:token) { api_token(seller, scopes: "edit_products") }

  describe "custom fields" do
    def custom_fields_path(suffix = "") = "/products/#{product.external_id}/custom_fields#{suffix}"

    it "creates a custom field", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: "Nickname", required: "true" })

      expect(response.parsed_body["custom_field"]).to include("name" => "Nickname", "required" => true, "type" => "text")
      expect(product.custom_fields.reload.map(&:name)).to eq(["Nickname"])
    end

    it "creates a custom field from JSON, where required: true is not the string \"true\"", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: "Nickname", required: true, type: "long_text" }, as: :json, api_host: false)

      expect(response.parsed_body["custom_field"]).to include("required" => false, "type" => "long_text")
    end

    it "names the field after its url or label", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: "  ", url: "", label: "From the label" })

      expect(response.parsed_body["custom_field"]["name"]).to eq("From the label")
    end

    it "creates a terms field with a valid url", parity: true do
      api_call(:post, custom_fields_path, token:, params: { url: "https://example.com/terms?x=1#top", type: "terms" })

      expect(response.parsed_body["custom_field"]).to include("type" => "terms")
    end

    it "refuses a terms field whose name is not a url", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: "not a url", type: "terms" })

      expect(response.parsed_body).to eq("success" => false, "message" => "Please provide a valid URL for custom field of Terms type.")
    end

    it "refuses an unknown type", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: "Nickname", type: "radio" })

      expect(response.parsed_body["message"]).to eq("Field type is not included in the list")
    end

    it "refuses a request without a name", parity: true do
      api_call(:post, custom_fields_path, token:, params: { required: "true" })

      expect(response.parsed_body["message"]).to eq("The custom_field was unable to be created.")
    end

    it "refuses a read-only token", parity: true do
      api_call(:post, custom_fields_path, token: api_token(seller, scopes: "view_public"), params: { name: "Nickname" })

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a list-valued name back to Rails", parity: true do
      api_call(:post, custom_fields_path, token:, params: { name: ["Nickname"] }, as: :json)

      expect(response).to have_http_status(:ok)
    end

    describe "with an existing field" do
      let!(:field) { create(:custom_field, seller:, name: "Nickname", required: false).tap { _1.products << product } }

      it "makes the field required", parity: true do
        api_call(:put, custom_fields_path("/Nickname"), token:, params: { required: "true" })

        expect(response.parsed_body["custom_field"]["required"]).to be(true)
        expect(field.reload.required).to be(true)
      end

      it "changes nothing without a required parameter", parity: true do
        api_call(:patch, custom_fields_path("/Nickname"), token:, api_host: false)

        expect(response.parsed_body["custom_field"]["name"]).to eq("Nickname")
      end

      it "says the field was not found", parity: true do
        api_call(:put, custom_fields_path("/Missing"), token:, params: { required: "true" })

        expect(response.parsed_body["message"]).to eq("The custom_field was not found.")
      end

      it "reports the new value of a field that no longer validates without saving it", parity: true do
        field.update_columns(field_type: "terms")

        api_call(:put, custom_fields_path("/Nickname"), token:, params: { required: "true" })

        expect(response.parsed_body["custom_field"]["required"]).to be(true)
        expect(field.reload.required).to be(false)
      end

      it "deletes a field that belongs to this product alone", parity: true do
        api_call(:delete, custom_fields_path("/Nickname"), token:)

        expect(response.parsed_body["message"]).to eq("The custom_field was deleted successfully.")
        expect(CustomField.where(id: field.id)).to be_empty
      end

      it "detaches a field that belongs to several products", parity: true do
        field.products << create(:product, user: seller)

        api_call(:delete, custom_fields_path("/Nickname"), token:, api_host: false)

        expect(response.parsed_body["success"]).to be(true)
        expect(field.reload.products.count).to eq(1)
      end
    end
  end

  describe "variant categories" do
    def categories_path(suffix = "") = "/products/#{product.external_id}/variant_categories#{suffix}"

    it "creates a category with a title", parity: true do
      api_call(:post, categories_path, token:, params: { title: "Size" })

      expect(response.parsed_body["variant_category"]["title"]).to eq("Size")
      expect(product.variant_categories.reload.map(&:title)).to eq(["Size"])
    end

    it "creates a category from a JSON boolean title", parity: true do
      api_call(:post, categories_path, token:, params: { title: true }, as: :json)

      expect(response.parsed_body["variant_category"]["title"]).to be_a(String)
      expect(product.variant_categories.reload.map(&:title)).to eq([response.parsed_body["variant_category"]["title"]])
    end

    it "creates a category without a title and expires the product's cached values", parity: true do
      create(:product_cached_value, product:)

      api_call(:post, categories_path, token:, api_host: false)

      expect(response.parsed_body["variant_category"]["title"]).to be_nil
    end

    context "with a category" do
      let!(:category) { create(:variant_category, link: product, title: "Size") }

      it "renames the category", parity: true do
        create(:product_cached_value, product:)

        api_call(:put, categories_path("/#{category.external_id}"), token:, params: { title: "Colour" })

        expect(response.parsed_body["variant_category"]["title"]).to eq("Colour")
      end

      it "renames the category to a JSON boolean title", parity: true do
        api_call(:put, categories_path("/#{category.external_id}"), token:, params: { title: false }, as: :json)

        expect(response.parsed_body["variant_category"]["title"]).to eq(category.reload.title)
      end

      it "leaves an unchanged title alone", parity: true do
        create(:product_cached_value, product:)

        api_call(:patch, categories_path("/#{category.external_id}"), token:, params: { title: "Size" }, api_host: false)

        expect(response.parsed_body["variant_category"]["title"]).to eq("Size")
      end

      it "says the category was not found", parity: true do
        api_call(:put, categories_path("/nonexistent"), token:, params: { title: "Colour" })

        expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
      end
    end
  end
end
