# frozen_string_literal: true

require "spec_helper"

# The JSON endpoints of the product editor's uploads (S3 utility, Dropbox chooser) and of the download page (media locations), the way the
# browser calls them (XHR, CSRF token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/content-delivery-mutations.replay.test.ts, which sends the last request of each example.
describe "Content delivery JSON endpoints", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Upload Seller") }
  let(:product) { create(:product, user: seller, name: "Upload product", unique_permalink: "upl") }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/products" }
  end

  before { host! DOMAIN }

  def get_json(path, params = {})
    get path, params:, headers: json_headers.except("Content-Type")
  end

  def post_json(path, body = {})
    token = csrf_token
    post path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => token)
  end

  describe "S3 utility" do
    it "signs an upload under the seller's prefix", parity: true do
      log_in(seller)

      get_json s3_utility_generate_multipart_signature_path, to_sign: "PUT\n\n\n\n/#{S3_BUCKET}/attachments/#{seller.external_id}/file.pdf?partNumber=1"

      expect(response).to have_http_status(:ok)
      expect(response.body).to match(/\A[A-Za-z0-9+\/=]+\z/)
    end

    it "refuses to sign for another seller's prefix", parity: true do
      log_in(seller)

      get_json s3_utility_generate_multipart_signature_path, to_sign: "PUT\n/#{S3_BUCKET}/attachments/other/file.pdf"

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a request without a string to sign", parity: true do
      log_in(seller)

      get_json s3_utility_generate_multipart_signature_path

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses a to_sign that is not a string", parity: true do
      log_in(seller)

      get_json s3_utility_generate_multipart_signature_path, to_sign: ["a"]

      expect(response).to have_http_status(:bad_request)
    end

    it "answers the current time", parity: true do
      log_in(seller)

      get_json s3_utility_current_utc_time_string_path

      expect(response.body).to match(/GMT\z/)
    end

    it "answers the CDN URL of a blob as JSON", parity: true do
      log_in(seller)
      blob = ActiveStorage::Blob.create_before_direct_upload!(filename: "hello.txt", byte_size: 5, checksum: "XUFAKrxLKna5cZ2REBfFkg==", content_type: "text/plain")

      get_json s3_utility_cdn_url_for_blob_path, key: blob.key

      expect(response.parsed_body["url"]).to include(blob.key)
    end

    it "answers 404 for an unknown blob key", parity: true do
      log_in(seller)

      get_json s3_utility_cdn_url_for_blob_path, key: "nope"

      expect(response).to have_http_status(:not_found)
    end

    it "tells a support member that the action is not allowed", parity: true do
      support = create(:user, name: "Support Member")
      create(:team_membership, user: support, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(support)
      switch_to(support.reload.user_memberships.find_by(seller:))

      get_json s3_utility_current_utc_time_string_path

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["success"]).to be(false)
    end
  end

  describe "Dropbox files" do
    it "lists the files not attached to a product", parity: true do
      create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/a.pdf", json_data: { file_name: "a.pdf", file_size: 10 })
      create(:dropbox_file, user: seller, link: product, dropbox_url: "https://www.dropbox.com/b.pdf", json_data: { file_name: "b.pdf", file_size: 20 })
      create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/c.pdf", deleted_at: Time.utc(2025, 1, 1))
      log_in(seller)

      get_json dropbox_files_path

      expect(response.parsed_body["dropbox_files"].map { _1["name"] }).to eq(["a.pdf"])
    end

    it "lists the files of a product", parity: true do
      create(:dropbox_file, user: seller, link: product, dropbox_url: "https://www.dropbox.com/b.pdf", json_data: { file_name: "b.pdf", file_size: 20 })
      create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/a.pdf")
      log_in(seller)

      get_json dropbox_files_path, link_id: product.unique_permalink

      expect(response.parsed_body["dropbox_files"].map { _1["name"] }).to eq(["b.pdf"])
    end

    it "answers 404 for a product that is not the seller's", parity: true do
      log_in(seller)

      get_json dropbox_files_path, link_id: "nope"

      expect(response).to have_http_status(:not_found)
    end

    it "creates a file", parity: true do
      log_in(seller)

      post_json create_dropbox_file_path, name: "book.pdf", bytes: "1024", link: "https://www.dropbox.com/s/abc/book.pdf"

      expect(response.parsed_body["dropbox_file"]).to include("name" => "book.pdf", "bytes" => 1024, "state" => "in_progress")
      expect(DropboxFile.last.user).to eq(seller)
    end

    it "creates a file for a product", parity: true do
      log_in(seller)

      post_json create_dropbox_file_path, name: "book.pdf", bytes: 9, link: "https://www.dropbox.com/s/abc/book.pdf", link_id: product.unique_permalink

      expect(DropboxFile.last.link).to eq(product)
    end

    it "cancels a transfer in progress", parity: true do
      file = create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/a.pdf", json_data: { file_name: "a.pdf", file_size: 10 })
      log_in(seller)

      post_json cancel_dropbox_file_upload_path(file.external_id)

      expect(response.parsed_body).to include("success" => true)
      expect(file.reload).to have_attributes(state: "cancelled")
      expect(file.deleted_at).to be_present
    end

    it "deletes a file that was transferred", parity: true do
      file = create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/a.pdf", state: "successfully_uploaded", json_data: { file_name: "a.pdf", file_size: 10 })
      log_in(seller)

      post_json cancel_dropbox_file_upload_path(file.external_id)

      expect(file.reload).to have_attributes(state: "deleted")
    end

    it "does nothing for a file that already failed", parity: true do
      file = create(:dropbox_file, user: seller, dropbox_url: "https://www.dropbox.com/a.pdf", state: "failed")
      log_in(seller)

      post_json cancel_dropbox_file_upload_path(file.external_id)

      expect(response.parsed_body).to include("success" => true)
      expect(file.reload.state).to eq("failed")
    end

    it "answers success false for another seller's file", parity: true do
      file = create(:dropbox_file, user: create(:user), dropbox_url: "https://www.dropbox.com/a.pdf")
      log_in(seller)

      post_json cancel_dropbox_file_upload_path(file.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "Media locations" do
    let(:buyer) { create(:user, name: "Media Buyer") }
    let(:video) { create(:streamable_video, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/sample.mov") }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: buyer.email) }
    let!(:url_redirect) { purchase.create_url_redirect! }
    let(:media_params) { { url_redirect_id: url_redirect.external_id, product_file_id: video.external_id, platform: "web", location: "42" } }

    before { video }

    it "records the first location", parity: true do
      post_json media_locations_path, media_params

      expect(response.parsed_body).to eq("success" => true)
      expect(MediaLocation.last).to have_attributes(location: 42, unit: "seconds", platform: "web")
    end

    it "moves a recorded location forward", parity: true do
      create(:media_location, product_id: product.id, product_file_id: video.id, url_redirect_id: url_redirect.id, purchase_id: purchase.id, platform: "web", location: 42, consumed_at: 3.hours.ago)

      post_json media_locations_path, media_params.merge(location: "90")

      expect(response.parsed_body).to eq("success" => true)
      expect(MediaLocation.last.location).to eq(90)
    end

    it "ignores an older location", parity: true do
      post_json media_locations_path, media_params
      post_json media_locations_path, media_params.merge(location: "5", consumed_at: "2000-01-01T00:00:00Z")

      expect(response.parsed_body).to eq("success" => false)
      expect(MediaLocation.last.location).to eq(42)
    end

    it "answers false for an unknown platform", parity: true do
      post_json media_locations_path, media_params.merge(platform: "toaster")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false when a parameter is missing", parity: true do
      post_json media_locations_path, media_params.except(:location)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for a file that cannot be consumed", parity: true do
      other = create(:non_readable_document, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/a.txt")

      post_json media_locations_path, media_params.merge(product_file_id: other.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "records a page of a document", parity: true do
      pdf = create(:readable_document, link: product, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/b.pdf")

      post_json media_locations_path, media_params.merge(product_file_id: pdf.external_id, location: "3")

      expect(MediaLocation.last).to have_attributes(location: 3, unit: "page_number")
    end
  end
end
