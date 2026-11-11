# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::UrlRedirectsController through the whole stack, on the API host with a per-actor token. Recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are
# redirects whose files the delivery port does not prove (a product with rich content or version options, an installment's redirect):
# the replay asserts they reach the stand-in Rails untouched and write nothing.
describe "Internal admin API url redirects", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Video course") }
  let(:purchase) { create(:free_purchase, link: product, email: "buyer@example.com") }
  let!(:url_redirect) { create(:url_redirect, purchase:, link: product) }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  describe "GET show" do
    it "reads the files of a purchase's redirect with their download state", parity: true do
      create(:streamable_video, link: product, stream_only: true, display_name: "Lesson one", position: 0)
      create(:readable_document, link: product, display_name: "Workbook", position: 1)
      create(:external_link, link: product, display_name: nil, url: "https://example.com/bonus", position: 2)
      create(:readable_document, link: product, display_name: "Retired", position: 3).mark_deleted!

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response).to have_http_status(:ok)
      files = response.parsed_body.dig("url_redirect", "files")
      expect(files.map { _1["name"] }).to eq(["Lesson one", "Workbook", "https://example.com/bonus"])
      expect(files.map { _1["downloadable"] }).to eq([false, true, false])
    end

    it "names a file without a display name after its stored name", parity: true do
      create(:readable_document, link: product, display_name: nil)

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response.parsed_body.dig("url_redirect", "files").sole["name"]).to be_present
    end

    it "marks a stream-only file this buyer was granted as downloadable", parity: true do
      file = create(:streamable_video, link: product, stream_only: true, display_name: "Lesson one")
      ProductFileDownloadGrant.create!(url_redirect:, product_file: file)

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response.parsed_body.dig("url_redirect", "files").sole).to include("download_granted" => true, "downloadable" => true, "downloads_disabled" => true)
    end

    it "does not carry a grant over to another buyer's redirect", parity: true do
      file = create(:streamable_video, link: product, stream_only: true, display_name: "Lesson one")
      ProductFileDownloadGrant.create!(url_redirect:, product_file: file)
      other = create(:url_redirect, purchase: create(:free_purchase, link: product, email: "other@example.com"), link: product)

      get "/internal/admin/url_redirects/#{other.token}", headers: headers

      expect(response.parsed_body.dig("url_redirect", "files").sole).to include("download_granted" => false, "downloadable" => false)
    end

    it "keeps a rental's stream-only and streamable files out of reach", parity: true do
      create(:streamable_video, link: product, display_name: "Rented film")
      url_redirect.update!(is_rental: true)

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response.parsed_body.dig("url_redirect", "files").sole).to include("downloadable" => false, "downloads_disabled" => false)
    end

    it "reads a redirect that has no purchase", parity: true do
      create(:readable_document, link: product, display_name: "Workbook")
      bare = create(:url_redirect, purchase: nil, link: product)

      get "/internal/admin/url_redirects/#{bare.token}", headers: headers

      expect(response.parsed_body["url_redirect"]).to include("purchase_id" => nil, "buyer_email" => nil, "product_name" => "Video course")
    end

    it "returns not found for an unknown token", parity: true do
      get "/internal/admin/url_redirects/no-such-token", headers: headers

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Url redirect not found")
    end

    it "refuses a request without credentials", parity: true do
      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: { "Host" => API_DOMAIN }

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a redirect of a product with rich content to Rails", parity: true do
      create(:rich_content, entity: product, description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Welcome" }] }])

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a redirect of a product with version options to Rails", parity: true do
      create(:variant_category, link: product, title: "Edition")

      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST grant_download" do
    let!(:video) { create(:streamable_video, link: product, stream_only: true, display_name: "Lesson one") }

    def grant(file_id: video.external_id, token: url_redirect.token, **options)
      post "/internal/admin/url_redirects/#{token}/grant_download", params: { product_file_id: file_id }, headers: headers, **options
    end

    it "grants a stream-only file to this buyer and audits it without the token", parity: true do
      expect { grant }.to change(ProductFileDownloadGrant, :count).by(1)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.dig("url_redirect", "files").sole).to include("download_granted" => true, "downloadable" => true)
      expect(AdminApiAuditLog.last).to have_attributes(action: "url_redirects.grant_download", route: "/internal/admin/url_redirects/[REDACTED]/grant_download")
    end

    it "grants the same file twice without a second row", parity: true do
      grant

      expect { grant }.not_to change(ProductFileDownloadGrant, :count)
      expect(response).to have_http_status(:ok)
    end

    it "reads a JSON body the same way", parity: true do
      grant(as: :json)

      expect(response).to have_http_status(:ok)
      expect(AdminApiAuditLog.last.params_snapshot).to include("id" => "[REDACTED]", "product_file_id" => video.external_id)
    end

    it "refuses a file whose downloads are already enabled", parity: true do
      document = create(:readable_document, link: product, display_name: "Workbook")

      expect { grant(file_id: document.external_id) }.not_to change(ProductFileDownloadGrant, :count)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Downloads are already enabled for this file")
    end

    it "refuses a rental purchase", parity: true do
      url_redirect.update!(is_rental: true)

      grant

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Rental purchases cannot be granted downloads")
    end

    it "refuses a redirect that has no purchase", parity: true do
      bare = create(:url_redirect, purchase: nil, link: product)

      grant(token: bare.token)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Downloads can only be granted on a purchase's url redirect")
    end

    it "returns not found for a file of another product", parity: true do
      other = create(:streamable_video, link: create(:product, user: seller), stream_only: true)

      grant(file_id: other.external_id)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("File not found")
    end

    it "returns not found for an id that is not a file id", parity: true do
      grant(file_id: "not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "returns not found for an unknown token", parity: true do
      grant(token: "no-such-token")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Url redirect not found")
    end

    it "hands a redirect of a product with version options to Rails", parity: true do
      create(:variant_category, link: product, title: "Edition")

      grant

      expect(response).to have_http_status(:ok)
    end
  end

  describe "DELETE revoke_download" do
    let!(:video) { create(:streamable_video, link: product, stream_only: true, display_name: "Lesson one") }

    def revoke(file_id: video.external_id, token: url_redirect.token, **options)
      delete "/internal/admin/url_redirects/#{token}/revoke_download", params: { product_file_id: file_id }, headers: headers, **options
    end

    it "removes the grant and audits it without the token", parity: true do
      ProductFileDownloadGrant.create!(url_redirect:, product_file: video)

      expect { revoke }.to change(ProductFileDownloadGrant, :count).by(-1)

      expect(response.parsed_body.dig("url_redirect", "files").sole).to include("download_granted" => false, "downloadable" => false)
      expect(AdminApiAuditLog.last).to have_attributes(action: "url_redirects.revoke_download", route: "/internal/admin/url_redirects/[REDACTED]/revoke_download")
    end

    it "keeps the grants of other buyers", parity: true do
      other = create(:url_redirect, purchase: create(:free_purchase, link: product, email: "other@example.com"), link: product)
      ProductFileDownloadGrant.create!(url_redirect:, product_file: video)
      ProductFileDownloadGrant.create!(url_redirect: other, product_file: video)

      expect { revoke }.to change(ProductFileDownloadGrant, :count).by(-1)
      expect(ProductFileDownloadGrant.where(url_redirect: other)).to exist
    end

    it "answers ok when the buyer holds no grant", parity: true do
      expect { revoke }.not_to change(ProductFileDownloadGrant, :count)

      expect(response).to have_http_status(:ok)
    end

    it "reads a JSON body the same way", parity: true do
      ProductFileDownloadGrant.create!(url_redirect:, product_file: video)

      revoke(as: :json)

      expect(response).to have_http_status(:ok)
      expect(AdminApiAuditLog.last.params_snapshot).to include("id" => "[REDACTED]")
    end

    it "returns not found for a file of another product", parity: true do
      other = create(:streamable_video, link: create(:product, user: seller), stream_only: true)

      revoke(file_id: other.external_id)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("File not found")
    end

    it "returns not found for an unknown token", parity: true do
      revoke(token: "no-such-token")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "with the legacy admin token" do
    let(:legacy_actor) { create(:admin_user, id: GUMROAD_ADMIN_ID, name: "Legacy Admin", email: "legacy-admin@example.com") }
    let(:legacy_headers) { { "Authorization" => "Bearer shared-token", "Host" => API_DOMAIN } }

    before do
      create(:admin_api_token, actor_user: legacy_actor, token_hash: AdminApiToken.hash_token("shared-token"))
    end

    it "reads a redirect, which needs no per-actor token", parity: true do
      get "/internal/admin/url_redirects/#{url_redirect.token}", headers: legacy_headers

      expect(response).to have_http_status(:ok)
    end

    it "refuses to grant a download", parity: true do
      file = create(:streamable_video, link: product, stream_only: true)

      expect do
        post "/internal/admin/url_redirects/#{url_redirect.token}/grant_download", params: { product_file_id: file.external_id }, headers: legacy_headers
      end.not_to change(ProductFileDownloadGrant, :count)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["message"]).to eq("per-actor admin token is required")
    end

    it "refuses to revoke a download", parity: true do
      file = create(:streamable_video, link: product, stream_only: true)
      ProductFileDownloadGrant.create!(url_redirect:, product_file: file)

      expect do
        delete "/internal/admin/url_redirects/#{url_redirect.token}/revoke_download", params: { product_file_id: file.external_id }, headers: legacy_headers
      end.not_to change(ProductFileDownloadGrant, :count)

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
