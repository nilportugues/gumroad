# frozen_string_literal: true

require "spec_helper"

# AssetPreviewsController and ThumbnailsController: the product editor's cover and thumbnail uploads, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each example. An
# example named "hands a ..." records what Node passes to Rails whole: the upload is attached or an existing cover or file-backed thumbnail is deleted.
describe "Editor media guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Media Seller") }
  let(:product) { create(:product, user: seller, name: "Media product", unique_permalink: "mediaprod") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  describe "POST /links/:link_id/asset_previews" do
    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, "/links/#{product.unique_permalink}/asset_previews", asset_preview: { url: "https://example.com/preview.png" })

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    end

    it "answers not found for an unknown product", parity: true do
      log_in(seller)

      send_json(:post, "/links/nosuchproduct/asset_previews", asset_preview: { url: "https://example.com/preview.png" })

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for the product of another seller", parity: true do
      other = create(:product, user: create(:user, name: "Other Seller"), unique_permalink: "otherprod")
      log_in(seller)

      send_json(:post, "/links/#{other.unique_permalink}/asset_previews", asset_preview: { url: "https://example.com/preview.png" })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a request without an asset preview to Rails, whose JSON wrapping makes it an empty object", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/asset_previews")

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses an asset preview that is null", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/asset_previews", asset_preview: nil)

      expect(response.parsed_body).to eq("success" => false, "error" => "Could not process your preview, please try again.")
    end

    it "refuses an asset preview that is not an object", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/asset_previews", asset_preview: "https://example.com/preview.png")

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "hands a preview with an unverifiable blob to Rails", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/asset_previews", asset_preview: { signed_blob_id: "forged" })

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "DELETE /links/:link_id/asset_previews/:id" do
    it "answers not found for an unknown product", parity: true do
      log_in(seller)

      send_json(:delete, "/links/nosuchproduct/asset_previews/anything")

      expect(response).to have_http_status(:not_found)
    end

    it "answers a failed delete for a preview the product does not have", parity: true do
      log_in(seller)

      send_json(:delete, "/links/#{product.unique_permalink}/asset_previews/missingguid")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers a failed delete to a support team member for a preview the product does not have", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:delete, "/links/#{product.unique_permalink}/asset_previews/missingguid")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "refuses a support team member for a preview that exists", parity: true do
      preview = create(:asset_preview_youtube, link: product)
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:delete, "/links/#{product.unique_permalink}/asset_previews/#{preview.guid}")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a deletion of an existing preview to Rails", parity: true do
      preview = create(:asset_preview_youtube, link: product)
      log_in(seller)

      send_json(:delete, "/links/#{product.unique_permalink}/asset_previews/#{preview.guid}")

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "POST /links/:link_id/thumbnails" do
    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, "/links/#{product.unique_permalink}/thumbnails", thumbnail: { signed_blob_id: "forged" })

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers not found for an unknown product", parity: true do
      log_in(seller)

      send_json(:post, "/links/nosuchproduct/thumbnails", thumbnail: { signed_blob_id: "forged" })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a request without a thumbnail to Rails, whose JSON wrapping makes it an empty object", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/thumbnails")

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses a thumbnail that is null", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/thumbnails", thumbnail: nil)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid thumbnail parameter. Expected signed_blob_id.")
    end

    it "refuses a thumbnail that is not an object", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/thumbnails", thumbnail: "forged")

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a thumbnail with an unverifiable blob to Rails", parity: true do
      log_in(seller)

      send_json(:post, "/links/#{product.unique_permalink}/thumbnails", thumbnail: { signed_blob_id: "forged" })

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["error"]).to eq("Invalid signed_blob_id.")
    end
  end

  describe "DELETE /links/:link_id/thumbnails/:id" do
    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:delete, "/links/#{product.unique_permalink}/thumbnails/anything")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers a failed delete when the product has no thumbnail", parity: true do
      log_in(seller)

      send_json(:delete, "/links/#{product.unique_permalink}/thumbnails/missingguid")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers a failed delete for the guid of another thumbnail", parity: true do
      Thumbnail.create!(product:, unsplash_url: "https://images.unsplash.com/photo-parity")
      log_in(seller)

      send_json(:delete, "/links/#{product.unique_permalink}/thumbnails/missingguid")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "soft-deletes the product's thumbnail and touches the product", parity: true do
      thumbnail = Thumbnail.create!(product:, unsplash_url: "https://images.unsplash.com/photo-parity")
      # Aged, so that the touch moves `updated_at` instead of landing in the second the rows were created.
      aged = 10.minutes.ago
      thumbnail.update_columns(created_at: aged, updated_at: aged)
      product.update_columns(updated_at: aged)
      log_in(seller)

      send_json(:delete, "/links/#{product.unique_permalink}/thumbnails/#{thumbnail.guid}")

      expect(response.parsed_body).to eq("success" => true, "thumbnail" => { "url" => "https://images.unsplash.com/photo-parity", "guid" => thumbnail.guid })
    end
  end
end
