# frozen_string_literal: true

require "spec_helper"

# Api::V2::ThumbnailsController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the checks that run before storage or the product is touched; attaching
# a blob, fetching a URL and soft-deleting a thumbnail (which touches the product) are recorded as what Node hands back.
describe "API v2 thumbnails", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Thumb Seller", email: "thumb-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Pictured", unique_permalink: "pictured") }
  let(:token) { api_token(seller) }

  def thumbnail_call(verb, params = {}, options = {})
    api_call(verb, "/products/#{options.fetch(:product_id) { product.external_id }}/thumbnail", params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  describe "POST /products/:link_id/thumbnail" do
    it "asks for a signed_blob_id or url", parity: true do
      thumbnail_call(:post)

      expect(response.parsed_body).to eq("success" => false, "message" => "Please provide a signed_blob_id or url.")
    end

    it "asks for a signed_blob_id or url when both are blank", parity: true do
      thumbnail_call(:post, { signed_blob_id: " ", url: "" })

      expect(response.parsed_body["message"]).to eq("Please provide a signed_blob_id or url.")
    end

    it "asks for a signed_blob_id or url when the blob id is an empty list", parity: true do
      thumbnail_call(:post, { signed_blob_id: [], url: nil }, as: :json)

      expect(response.parsed_body["message"]).to eq("Please provide a signed_blob_id or url.")
    end

    it "refuses a signed_blob_id that is a number", parity: true do
      thumbnail_call(:post, { signed_blob_id: 5 }, as: :json)

      expect(response.parsed_body).to eq("success" => false, "message" => "The signed_blob_id is invalid or expired.")
    end

    it "refuses a signed_blob_id that is a list", parity: true do
      thumbnail_call(:post, { signed_blob_id: ["abc"], url: "https://example.com/a.png" }, as: :json)

      expect(response.parsed_body["message"]).to eq("The signed_blob_id is invalid or expired.")
    end

    it "does not find an unknown product", parity: true do
      thumbnail_call(:post, { url: "https://example.com/a.png" }, product_id: "unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      thumbnail_call(:post, { url: "https://example.com/a.png" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      thumbnail_call(:post, { url: "https://example.com/a.png" }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "asks for a signed_blob_id or url through the /api prefix on the Gumroad domain", parity: true do
      thumbnail_call(:post, {}, api_host: false)

      expect(response.parsed_body["message"]).to eq("Please provide a signed_blob_id or url.")
    end

    it "hands a signed_blob_id to Rails", parity: true do
      thumbnail_call(:post, { signed_blob_id: "not-a-signed-id" })

      expect(response.parsed_body).to eq("success" => false, "message" => "The signed_blob_id is invalid or expired.")
    end

    it "hands a url to Rails", parity: true do
      thumbnail_call(:post, { url: "http://127.0.0.1/a.png" })

      expect(response).to have_http_status(:ok)
    end

    it "hands a url together with a blank signed_blob_id to Rails", parity: true do
      thumbnail_call(:post, { signed_blob_id: "", url: "http://localhost/a.png" })

      expect(response).to have_http_status(:ok)
    end
  end

  describe "DELETE /products/:link_id/thumbnail" do
    it "does not find a thumbnail on a product without one", parity: true do
      thumbnail_call(:delete)

      expect(response.parsed_body).to eq("success" => false, "message" => "The thumbnail was not found.")
    end

    it "does not find a thumbnail that was already deleted", parity: true do
      create(:thumbnail, product:).mark_deleted!

      thumbnail_call(:delete)

      expect(response.parsed_body["message"]).to eq("The thumbnail was not found.")
    end

    it "does not find the product", parity: true do
      thumbnail_call(:delete, {}, product_id: "unknown")

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      thumbnail_call(:delete, {}, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a deletion of a thumbnail to Rails", parity: true do
      thumbnail = create(:thumbnail, product:)

      thumbnail_call(:delete)

      expect(response.parsed_body).to include("success" => true)
      expect(thumbnail.reload.deleted_at).to be_present
    end

    it "hands a deletion of an unsplash thumbnail through the /api prefix on the Gumroad domain to Rails", parity: true do
      create(:unsplash_thumbnail, product:)

      thumbnail_call(:delete, {}, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end
end
