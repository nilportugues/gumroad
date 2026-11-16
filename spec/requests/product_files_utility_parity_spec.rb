# frozen_string_literal: true

require "spec_helper"

# ProductFilesUtilityController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/product-files-utility.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole.
describe "ProductFilesUtilityController", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Files Seller") }
  let(:product) { create(:product, user: seller, name: "Files product", unique_permalink: "filesproduct") }
  let(:file) { create(:listenable_audio, link: product) }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def get_json(path, params = {})
    get path, params:, headers: { "Accept" => "application/json" }
  end

  describe "GET /product_files_utility/external_link_title", :skip_ssrf_stub do
    it "answers the 404 of authenticate_user! to a signed-out visitor", parity: true do
      get_json external_link_title_path, url: "https://example.com"

      expect(response).to have_http_status(:not_found)
    end

    it "answers failure without a url", parity: true do
      log_in(seller)

      get_json external_link_title_path

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a url that is not a url", parity: true do
      log_in(seller)

      get_json external_link_title_path, url: "invalid url"

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a loopback address", parity: true do
      log_in(seller)

      get_json external_link_title_path, url: "http://127.0.0.1/title"

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for localhost", parity: true do
      log_in(seller)

      get_json external_link_title_path, url: "http://localhost:3000"

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a private network address", parity: true do
      log_in(seller)

      get_json external_link_title_path, url: "http://10.0.0.5/page"

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a scheme other than http and https", parity: true do
      log_in(seller)

      get_json external_link_title_path, url: "ftp://example.com/file"

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /product_files_utility/product_files/:product_id" do
    it "answers the 404 of authenticate_user! to a signed-out visitor", parity: true do
      get_json download_product_files_path(product.external_id), product_file_ids: [file.external_id]

      expect(response).to have_http_status(:not_found)
    end

    it "sends a signed-out visitor who asks for a page to sign in", parity: true do
      get download_product_files_path(product.external_id), params: { product_file_ids: [file.external_id] }

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "answers 404 for a product that does not exist", parity: true do
      log_in(seller)

      get_json download_product_files_path("nosuchproduct"), product_file_ids: [file.external_id]

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's product", parity: true do
      other = create(:product, user: create(:user, name: "Other Seller"))
      log_in(seller)

      get_json download_product_files_path(other.external_id), product_file_ids: [file.external_id]

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      get_json download_product_files_path(product.external_id), product_file_ids: [file.external_id]

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("Your current role as Support cannot perform this action.")
    end

    it "answers 404 without file ids", parity: true do
      log_in(seller)

      get_json download_product_files_path(product.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a file id that names no file of the library", parity: true do
      log_in(seller)

      get_json download_product_files_path(product.external_id), product_file_ids: ["nosuchfile"]

      expect(response).to have_http_status(:not_found)
    end

    it "lists the signed url and filename of a file", parity: true do
      file
      log_in(seller)

      get_json download_product_files_path(product.external_id), product_file_ids: [file.external_id]

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["files"].first["filename"]).to eq("magic.mp3")
    end

    it "redirects a page request to the signed url of the file", parity: true do
      file
      log_in(seller)

      get download_product_files_path(product.external_id), params: { product_file_ids: [file.external_id] }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("magic.mp3")
    end

    it "lists a file of the seller's library that belongs to another product", parity: true do
      other_file = create(:streamable_video, link: create(:product, user: seller, name: "Sibling"))
      log_in(seller)

      get_json download_product_files_path(product.external_id), product_file_ids: [other_file.external_id]

      expect(response).to have_http_status(:ok)
    end

    it "answers that a file is gone when its object is missing from storage", parity: true do
      missing = create(:product_file, link: product)
      log_in(seller)

      get_json download_product_files_path(product.external_id), product_file_ids: [missing.external_id]

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["error"]).to eq("This file is no longer available. Please re-upload it.")
    end

    it "sends a page request for a missing object back to the product editor with a warning", parity: true do
      missing = create(:product_file, link: product)
      log_in(seller)

      get download_product_files_path(product.external_id), params: { product_file_ids: [missing.external_id] }

      expect(response).to have_http_status(:found)
      expect(flash[:warning]).to eq("This file is no longer available. Please re-upload it.")
    end

    it "hands a request for several files to Rails", parity: true do
      second = create(:streamable_video, link: product)
      log_in(seller)

      file
      get_json download_product_files_path(product.external_id), product_file_ids: [file.external_id, second.external_id]

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["files"].size).to eq(2)
    end
  end

  describe "GET /product_files_utility/folder_archive/:folder_id" do
    def ready_archive(folder_id: "folder1", variant: nil)
      archive = create(:product_files_archive, link: variant ? nil : product, variant:, folder_id:)
      archive.update_columns(product_files_archive_state: "ready", url: "#{S3_BASE_URL}specs/magic.mp3")
      archive
    end

    it "answers the 404 of authenticate_user! to a signed-out visitor", parity: true do
      get_json download_folder_archive_path("folder1"), product_id: product.external_id

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's product", parity: true do
      other = create(:product, user: create(:user, name: "Other Seller"))
      log_in(seller)

      get_json download_folder_archive_path("folder1"), product_id: other.external_id

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      get_json download_folder_archive_path("folder1"), product_id: product.external_id

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers a null url when the folder has no ready archive", parity: true do
      log_in(seller)

      get_json download_folder_archive_path("folder1"), product_id: product.external_id

      expect(response.parsed_body).to eq("url" => nil)
    end

    it "answers the route that redirects to the folder's ready archive", parity: true do
      ready_archive
      log_in(seller)

      get_json download_folder_archive_path("folder1"), product_id: product.external_id

      expect(response.parsed_body["url"]).to include("/product_files_utility/folder_archive/folder1")
    end

    it "redirects a page request to the signed url of the ready archive", parity: true do
      ready_archive
      log_in(seller)

      get download_folder_archive_path("folder1"), params: { product_id: product.external_id }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("magic.mp3")
    end

    it "answers 404 to a page request for a folder without a ready archive", parity: true do
      log_in(seller)

      get download_folder_archive_path("folder1"), params: { product_id: product.external_id }

      expect(response).to have_http_status(:not_found)
    end

    it "ignores an archive that is not ready", parity: true do
      archive = ready_archive
      archive.update_columns(product_files_archive_state: "in_progress")
      log_in(seller)

      get_json download_folder_archive_path("folder1"), product_id: product.external_id

      expect(response.parsed_body).to eq("url" => nil)
    end

    it "hands a request for a version's archive to Rails", parity: true do
      category = create(:variant_category, link: product)
      variant = create(:variant, variant_category: category)
      ready_archive(variant:)
      log_in(seller)

      get_json download_folder_archive_path("folder1"), product_id: product.external_id, variant_id: variant.external_id

      expect(response).to have_http_status(:ok)
    end
  end
end
