# frozen_string_literal: true

require "spec_helper"

# Api::V2::FilesController (#presign, #complete, #abort) and Api::V2::DirectUploadsController#create, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts). Node answers every 400 that comes before the first S3 call or blob insert;
# an example named "hands a ... back to Rails" records a request that passes them and goes on to S3 or the blob table.
describe "API v2 file uploads", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let(:key) { "attachments/#{seller.external_id}/0123456789abcdef/original/a.zip" }
  let(:blob) { { filename: "a.png", byte_size: 1024, checksum: "6vfPzS3sS8z1GfVhqkB5xg==", content_type: "image/png" } }

  describe "POST presign" do
    it "refuses a read-only token", parity: true do
      api_call(:post, "/files/presign", token: api_token(seller, scopes: "view_public"), params: { filename: "a.zip", file_size: 10 })

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a blank filename", parity: true do
      api_call(:post, "/files/presign", token:, params: { filename: "  ", file_size: 10 })

      expect(response.parsed_body["error"]).to eq("filename is required")
    end

    it "refuses a missing file_size", parity: true do
      api_call(:post, "/files/presign", token:, params: { filename: "a.zip" })

      expect(response.parsed_body["error"]).to eq("file_size is required")
    end

    it "refuses a file_size that is not a number", parity: true do
      api_call(:post, "/files/presign", token:, params: { filename: "a.zip", file_size: "big" }, api_host: false)

      expect(response.parsed_body["error"]).to eq("file_size is required")
    end

    it "refuses a file_size above 20 GB", parity: true do
      api_call(:post, "/files/presign", token:, params: { filename: "a.zip", file_size: 21 * 1024**3 }, as: :json)

      expect(response.parsed_body["error"]).to eq("file_size exceeds the 20 GB maximum")
    end

    it "hands a presign back to Rails", parity: true do
      api_call(:post, "/files/presign", token:, params: { filename: "a.zip", file_size: 10 })

      expect(response.parsed_body).to include("success" => true)
      expect(response.parsed_body["parts"].size).to eq(1)
    end
  end

  describe "POST complete" do
    it "refuses a read-only token", parity: true do
      api_call(:post, "/files/complete", token: api_token(seller, scopes: "view_public"), params: { upload_id: "u", key:, parts: [{ part_number: 1, etag: "e" }] }, as: :json)

      expect(response).to have_http_status(:forbidden)
    end

    it "asks for an upload_id", parity: true do
      api_call(:post, "/files/complete", token:, params: { key: })

      expect(response.parsed_body["error"]).to eq("upload_id is required")
    end

    it "asks for a key", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u" })

      expect(response.parsed_body["error"]).to eq("key is required")
    end

    it "asks for parts", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key: }, api_host: false)

      expect(response.parsed_body["error"]).to eq("parts is required")
    end

    it "treats an empty list of parts as missing", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key:, parts: [] }, as: :json)

      expect(response.parsed_body["error"]).to eq("parts is required")
    end

    it "refuses a key outside the seller's folder", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key: "attachments/someone-else/a.zip", parts: [{ part_number: 1, etag: "e" }] }, as: :json)

      expect(response.parsed_body["error"]).to eq("invalid key")
    end

    it "refuses a part without an etag", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key:, parts: [{ part_number: 1 }] }, as: :json)

      expect(response.parsed_body["error"]).to eq("each part must have scalar part_number and etag values")
    end

    it "refuses a part that is not an object", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key:, parts: ["1:e"] }, as: :json)

      expect(response.parsed_body["error"]).to eq("each part must have scalar part_number and etag values")
    end

    it "refuses a part whose part_number is a list", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "u", key:, parts: [{ part_number: [1], etag: "e" }] }, as: :json)

      expect(response.parsed_body["error"]).to eq("each part must have scalar part_number and etag values")
    end

    it "hands a completion of an unknown upload back to Rails", parity: true do
      api_call(:post, "/files/complete", token:, params: { upload_id: "unknown", key:, parts: [{ part_number: 1, etag: "e" }] }, as: :json)

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "POST abort" do
    it "refuses a read-only token", parity: true do
      api_call(:post, "/files/abort", token: api_token(seller, scopes: "view_public"), params: { upload_id: "u", key: })

      expect(response).to have_http_status(:forbidden)
    end

    it "asks for an upload_id", parity: true do
      api_call(:post, "/files/abort", token:, params: { key: })

      expect(response.parsed_body["error"]).to eq("upload_id is required")
    end

    it "asks for a key", parity: true do
      api_call(:post, "/files/abort", token:, params: { upload_id: "u" }, api_host: false)

      expect(response.parsed_body["error"]).to eq("key is required")
    end

    it "refuses a key outside the seller's folder", parity: true do
      api_call(:post, "/files/abort", token:, params: { upload_id: "u", key: "attachments/someone-else/a.zip" })

      expect(response.parsed_body["error"]).to eq("invalid key")
    end

    it "hands an abort of an unknown upload back to Rails", parity: true do
      api_call(:post, "/files/abort", token:, params: { upload_id: "unknown", key: })

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "POST /direct_uploads" do
    it "refuses a read-only token", parity: true do
      api_call(:post, "/direct_uploads", token: api_token(seller, scopes: "view_public"), params: { blob: }, as: :json)

      expect(response).to have_http_status(:forbidden)
    end

    it "wants edit_profile for a media reservation", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { purpose: "media", blob: }, as: :json)

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a blob that is not an object", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: "a.png" })

      expect(response.parsed_body["error"]).to eq("blob must be an object")
    end

    it "refuses a request without a blob", parity: true do
      api_call(:post, "/direct_uploads", token:, api_host: false)

      expect(response.parsed_body["error"]).to eq("blob must be an object")
    end

    it "names the first blob argument that is missing", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.except(:filename, :checksum) }, as: :json)

      expect(response.parsed_body["error"]).to eq("filename is required")
    end

    it "names a missing checksum", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.except(:checksum) }, as: :json)

      expect(response.parsed_body["error"]).to eq("checksum is required")
    end

    it "refuses an empty byte_size", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.merge(byte_size: 0) }, as: :json)

      expect(response.parsed_body["error"]).to eq("byte_size is required")
    end

    it "refuses a byte_size above 20 GB", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.merge(byte_size: 21 * 1024**3) }, as: :json)

      expect(response.parsed_body["error"]).to eq("byte_size exceeds the 20 GB maximum")
    end

    it "refuses a content type that is neither an image nor a video", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.merge(content_type: "application/pdf") }, as: :json)

      expect(response.parsed_body["error"]).to eq("content_type must be JPEG, PNG, GIF, or video.")
    end

    it "refuses a blob without a content type", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: blob.except(:content_type) }, as: :json)

      expect(response.parsed_body["error"]).to eq("content_type must be JPEG, PNG, GIF, or video.")
    end

    it "refuses a media reservation over 10 MB", parity: true do
      api_call(:post, "/direct_uploads", token: api_token(seller, scopes: "edit_profile"), params: { purpose: "media", blob: blob.merge(byte_size: 10.megabytes + 1) }, as: :json)

      expect(response.parsed_body["error"]).to eq("byte_size exceeds the 10 MB maximum for media uploads")
    end

    it "refuses a media reservation that is not an image", parity: true do
      api_call(:post, "/direct_uploads", token: api_token(seller, scopes: "edit_profile"), params: { purpose: "media", blob: blob.merge(content_type: "video/mp4") }, as: :json)

      expect(response.parsed_body["error"]).to eq("content_type must be an image type.")
    end

    it "refuses an svg media reservation", parity: true do
      api_call(:post, "/direct_uploads", token: api_token(seller, scopes: "edit_profile"), params: { purpose: "media", blob: blob.merge(content_type: "image/svg+xml") }, as: :json)

      expect(response.parsed_body["error"]).to eq("content_type must be an image type.")
    end

    it "hands a reservation for a product file back to Rails", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: }, as: :json)

      expect(response.parsed_body["signed_id"]).to be_present
      expect(ActiveStorage::Blob.last.metadata).to include("uploaded_by_user_id" => seller.id)
    end

    it "hands a reservation for the media library back to Rails", parity: true do
      api_call(:post, "/direct_uploads", token: api_token(seller, scopes: "edit_profile"), params: { purpose: "media", blob: }, as: :json)

      expect(response.parsed_body["signed_id"]).to be_present
    end

    it "refuses an empty blob", parity: true do
      api_call(:post, "/direct_uploads", token:, params: { blob: {} }, as: :json)

      expect(response).to have_http_status(:bad_request)
    end
  end
end
