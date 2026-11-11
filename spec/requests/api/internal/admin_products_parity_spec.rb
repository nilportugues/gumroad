# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::ProductsController through the whole stack, on the API host with a per-actor token. Recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are
# requests the port leaves to Rails (a cover that is an uploaded file or an oembed, the signed URL of a stored file, holding a listing
# that is still on sale): the replay asserts they reach the stand-in Rails untouched and write nothing.
describe "Internal admin API products", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Design course", description: "<p>Learn & <b>design</b></p>") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  def sell(link, created_at: 10.days.ago, chargeback_date: nil, **attributes)
    purchase = build(:purchase, link:, seller: link.user, purchase_state: "successful", created_at:, **attributes)
    purchase.save!(validate: false)
    purchase.update_columns(chargeback_date:) if chargeback_date
    purchase
  end

  describe "GET index" do
    it "lists a seller's products live first with files, taxonomy and affiliates", parity: true do
      root = Taxonomy.create!(slug: "physical-goods")
      books = Taxonomy.create!(slug: "books", parent: root)
      live = create(:product, user: seller, name: "Live guide", taxonomy: books, created_at: 3.days.ago)
      create(:readable_document, link: live, display_name: "Guide", size: 1_048_576, position: 1)
      create(:external_link, link: live, display_name: "Telegram channel", url: "https://t.me/secret-channel", position: 0)
      create(:direct_affiliate, seller:, affiliate_user: create(:user, email: "affiliate@example.com"), affiliate_basis_points: 1500, products: [live])
      gone = create(:product, user: seller, name: "Old draft", created_at: 1.day.ago)
      gone.mark_deleted!
      paused = create(:product, user: seller, name: "Paused", created_at: 2.days.ago)
      paused.update_column(:purchase_disabled_at, 1.hour.ago)

      get "/internal/admin/products", params: { email: seller.email }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Live guide", "Old draft", "Paused"])
      expect(response.parsed_body["products"].first["taxonomy"]["ancestry_path"]).to eq(["physical-goods", "books"])
    end

    it "looks the seller up by external_id and pages the products", parity: true do
      3.times { |index| create(:product, user: seller, name: "Product #{index}", created_at: (index + 1).days.ago) }

      get "/internal/admin/products", params: { external_id: seller.external_id, per_page: 2, page: 2 }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["products"].map { _1["name"] }).to eq(["Product 2"])
      expect(response.parsed_body["pagination"]).to include("count" => 3, "items" => 2, "page" => 2, "pages" => 2, "prev" => 1, "next" => nil)
    end

    it "returns an empty page for a page past the last", parity: true do
      create(:product, user: seller)

      get "/internal/admin/products", params: { email: seller.email, page: 4 }, headers: headers

      expect(response.parsed_body["products"]).to eq([])
      expect(response.parsed_body["pagination"]).to include("count" => 1, "page" => 4, "prev" => 1, "next" => nil)
    end

    it "treats a non-positive page as the first and caps per_page", parity: true do
      create(:product, user: seller)

      get "/internal/admin/products", params: { email: seller.email, page: "-3", per_page: "500" }, headers: headers

      expect(response.parsed_body["pagination"]).to include("page" => 1, "items" => 100)
    end

    it "returns an empty list for a seller with no products", parity: true do
      get "/internal/admin/products", params: { email: seller.email }, headers: headers

      expect(response.parsed_body).to include("products" => [], "pagination" => include("count" => 0, "pages" => 1))
    end

    it "serves a product whose cover is an unsplash image", parity: true do
      create(:asset_preview, link: product, attach: false, unsplash_url: "https://images.example.com/photo.jpg")

      get "/internal/admin/products", params: { email: seller.email }, headers: headers

      expect(response.parsed_body["products"].sole["preview_url"]).to eq("https://images.example.com/photo.jpg")
    end

    it "returns 400 without an email or external_id", parity: true do
      get "/internal/admin/products", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "returns 404 for an unknown email", parity: true do
      get "/internal/admin/products", params: { email: "missing@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "returns 404 for an unknown external_id", parity: true do
      get "/internal/admin/products", params: { external_id: "nonexistent" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a product with an oembed cover to Rails", parity: true do
      create(:asset_preview_youtube, link: product)

      get "/internal/admin/products", params: { email: seller.email }, headers: headers

      expect(response.parsed_body["products"].sole["preview_url"]).to be_present
    end
  end

  describe "GET show" do
    it "reads a product with its files, affiliates and fraud context", parity: true do
      create(:merchant_account, user: nil)
      create(:readable_document, link: product, display_name: "Removed extra", size: 256).mark_deleted!
      create(:readable_document, link: product, display_name: "Big guide", size: 1_048_576)
      direct = create(:direct_affiliate, seller:, affiliate_user: create(:user, email: "direct@example.com"), affiliate_basis_points: 1500, products: [product])
      ProductAffiliate.find_by!(affiliate: direct, product:).update!(affiliate_basis_points: nil, destination_url: "https://example.com/d")
      create(:product_affiliate, affiliate: create(:user).global_affiliate, product:)
      product.update_columns(bad_card_counter: 3, first_published_at: 5.days.ago)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response).to have_http_status(:ok)
      payload = response.parsed_body["product"]
      expect(payload["affiliates"].map { _1["type"] }).to eq(%w[DirectAffiliate])
      expect(payload["files"].map { _1["display_name"] }).to eq(["Removed extra", "Big guide"])
      expect(payload["active_sales_hold"]).to be_nil
    end

    it "lists a collaborator with its per-product basis points", parity: true do
      collab = create(:collaborator, seller:, affiliate_user: create(:user, email: "collab@example.com"), apply_to_all_products: false, affiliate_basis_points: 2000)
      create(:product_affiliate, affiliate: collab, product:, affiliate_basis_points: 2500)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body.dig("product", "affiliates").sole).to include("type" => "Collaborator", "basis_points" => 2500, "alive" => true)
    end

    it "lists a removed affiliate with its deleted_at", parity: true do
      direct = create(:direct_affiliate, seller:, affiliate_user: create(:user), products: [product])
      direct.update!(deleted_at: 1.day.ago)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body.dig("product", "affiliates").sole).to include("alive" => false, "deleted_at" => be_present)
    end

    it "reads the banned and paused state of a deleted product", parity: true do
      product.update_columns(banned_at: 1.day.ago, purchase_disabled_at: 2.days.ago, deleted_at: 3.days.ago)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body["product"]).to include("alive" => false, "banned_at" => be_present, "deleted_at" => be_present)
    end

    it "computes the chargeback rate over the last 90 days, leaving out reversed, bundle, PayPal and refunded sales", parity: true do
      4.times { sell(product) }
      sell(product, created_at: 5.days.ago, chargeback_date: 4.days.ago)
      sell(product, created_at: 100.days.ago, chargeback_date: 95.days.ago)
      reversed = sell(product, created_at: 6.days.ago, chargeback_date: 5.days.ago)
      reversed.update_columns(flags: reversed.flags | Purchase.flag_mapping["flags"][:chargeback_reversed])
      paypal = sell(product, created_at: 7.days.ago, chargeback_date: 5.days.ago)
      paypal.update_columns(charge_processor_id: PaypalChargeProcessor.charge_processor_id)
      bundled = sell(product, created_at: 8.days.ago, chargeback_date: 5.days.ago)
      bundled.update_columns(flags: bundled.flags | Purchase.flag_mapping["flags"][:is_bundle_product_purchase])
      sell(product, created_at: 9.days.ago).update_columns(stripe_refunded: true)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body["product"]["recent_chargeback_rate"]).to eq("window_days" => 90, "successful_count" => 6, "chargedback_count" => 1, "rate" => 0.1667)
    end

    it "reads a rate of zero when nothing was charged back", parity: true do
      sell(product)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body["product"]["recent_chargeback_rate"]).to include("successful_count" => 1, "chargedback_count" => 0, "rate" => 0.0)
    end

    it "reads a rate of nil when nothing sold in the window", parity: true do
      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body["product"]["recent_chargeback_rate"]).to eq("window_days" => 90, "successful_count" => 0, "chargedback_count" => 0, "rate" => nil)
    end

    it "includes the active sales hold", parity: true do
      product.unpublish!
      hold, = product.hold_sales!(seller:, held_by: admin)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body.dig("product", "active_sales_hold")).to include("id" => hold.external_id, "active" => true, "held_by_id" => admin.external_id)
    end

    it "returns 404 for an unknown product", parity: true do
      get "/internal/admin/products/#{Link.to_external_id(product.id + 1000)}", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "returns 404 for an id that does not decrypt", parity: true do
      get "/internal/admin/products/not-an-id", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a product with an oembed cover to Rails", parity: true do
      create(:asset_preview_youtube, link: product)

      get "/internal/admin/products/#{product.external_id}", headers: headers

      expect(response.parsed_body.dig("product", "preview_url")).to be_present
    end
  end

  describe "GET file download url" do
    def download_url(file_id, product_id: product.external_id)
      get "/internal/admin/products/#{product_id}/files/#{file_id}/download_url", headers: headers
    end

    it "returns the url of an external link file and audits the read", parity: true do
      external = create(:external_link, link: product, display_name: "Telegram channel", url: "https://t.me/secret-channel")

      download_url(external.external_id)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("signed_url" => "https://t.me/secret-channel", "external_link" => true)
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.file_download_url", target_type: "ProductFile", response_status: 200)
    end

    it "returns the url of a soft-deleted external link file", parity: true do
      external = create(:external_link, link: product, url: "https://t.me/removed")
      external.mark_deleted!

      download_url(external.external_id)

      expect(response.parsed_body["file"]).to include("id" => external.external_id, "deleted_at" => be_present)
    end

    it "returns 404 and audits the attempt for an unknown product", parity: true do
      download_url("whatever", product_id: Link.to_external_id(product.id + 1000))

      expect(response).to have_http_status(:not_found)
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.file_download_url", target_type: nil, response_status: 404)
    end

    it "returns 404 for a file of another product", parity: true do
      other = create(:external_link, link: create(:product, user: seller))

      download_url(other.external_id)

      expect(response.parsed_body["message"]).to eq("File not found")
    end

    it "hands a stored file to Rails for its signed url", parity: true do
      file = create(:readable_document, link: product, display_name: "Anthology")
      allow_any_instance_of(SignedUrlHelper).to receive(:signed_download_url_for_s3_key_and_filename).and_return("https://files.example.com/signed?sig=abc")

      download_url(file.external_id)

      expect(response.parsed_body).to include("signed_url" => "https://files.example.com/signed?sig=abc", "external_link" => false)
    end
  end

  describe "POST hold_sales" do
    let(:listing) { create(:product, user: seller, name: "Paused guide") }

    before { listing.update_column(:purchase_disabled_at, 1.hour.ago) }

    it "holds a listing the seller had already unpublished, leaving it as it was", parity: true do
      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("status" => "held", "sales_hold" => include("active" => true, "unpublished_listing" => false, "held_by_id" => admin.external_id))
      expect(listing.sales_holds.sole.external_id).to eq(response.parsed_body.dig("product", "active_sales_hold_id"))
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.hold_sales", target_type: "Link", target_external_id: listing.external_id, response_status: 200)
    end

    it "holds with a JSON body and reads the expected email", parity: true do
      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: seller.external_id, expected_email: "SELLER@example.com" }.to_json, headers: headers.merge("Content-Type" => "application/json")

      expect(response.parsed_body["status"]).to eq("held")
    end

    it "returns the existing hold when called again", parity: true do
      hold, = listing.hold_sales!(seller:, held_by: admin)

      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response.parsed_body).to include("status" => "already_held", "sales_hold" => include("id" => hold.external_id))
      expect(listing.sales_holds.count).to eq(1)
    end

    it "returns the existing hold of a listing that is still on sale", parity: true do
      live = create(:product, user: seller)
      hold = create(:product_sales_hold, product: live, held_by: admin)

      post "/internal/admin/products/#{live.external_id}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response.parsed_body).to include("status" => "already_held", "sales_hold" => include("id" => hold.external_id))
    end

    it "hands a listing that is still on sale to Rails", parity: true do
      live = create(:product, user: seller)

      post "/internal/admin/products/#{live.external_id}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response.parsed_body).to include("status" => "held", "sales_hold" => include("unpublished_listing" => true))
    end

    it "requires the seller's user_id and audits the refusal against the product", parity: true do
      post "/internal/admin/products/#{listing.external_id}/hold_sales", headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.hold_sales", target_external_id: listing.external_id, response_status: 400)
    end

    it "returns 404 for an unknown seller", parity: true do
      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: "nonexistent" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "returns 409 when the expected email does not match", parity: true do
      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: seller.external_id, expected_email: "other@example.com" }, headers: headers

      expect(response).to have_http_status(:conflict)
    end

    it "returns 404 for an unknown product and audits it without a target", parity: true do
      post "/internal/admin/products/#{Link.to_external_id(listing.id + 1000)}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:not_found)
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.hold_sales", target_type: nil, response_status: 404)
    end

    it "returns 422 for a product of another seller", parity: true do
      other = create(:user, email: "other@example.com")

      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: other.external_id }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(listing.sales_holds.count).to eq(0)
    end

    it "returns 404 for a seller whose account was deleted", parity: true do
      seller.mark_deleted!

      post "/internal/admin/products/#{listing.external_id}/hold_sales", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST release_sales_hold" do
    let(:listing) { create(:product, user: seller, name: "Paused guide") }
    let!(:hold) do
      listing.update_column(:purchase_disabled_at, 1.hour.ago)
      listing.hold_sales!(seller:, held_by: admin).first
    end

    def release(hold_id, user_id: seller.external_id, product_id: listing.external_id)
      post "/internal/admin/products/#{product_id}/release_sales_hold", params: { user_id:, hold_id: }.compact, headers: headers
    end

    it "lifts the hold, leaves the listing unpublished and audits the write", parity: true do
      release(hold.external_id)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("status" => "released", "sales_hold" => include("active" => false, "released_by_id" => admin.external_id), "product" => include("alive" => false, "active_sales_hold_id" => nil))
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.release_sales_hold", target_external_id: listing.external_id, response_status: 200)
    end

    it "leaves a newer hold in place when an older release is retried", parity: true do
      release(hold.external_id)
      newer, = listing.reload.hold_sales!(seller:, held_by: admin)

      release(hold.external_id)

      expect(response.parsed_body).to include("status" => "already_released", "product" => include("active_sales_hold_id" => newer.external_id))
    end

    it "requires the hold id and audits the refusal", parity: true do
      release(nil)

      expect(response).to have_http_status(:bad_request)
      expect(AdminApiAuditLog.last).to have_attributes(action: "products.release_sales_hold", target_external_id: listing.external_id, response_status: 400)
    end

    it "returns 404 for a hold on another product", parity: true do
      other = create(:product, user: seller)
      other.update_column(:purchase_disabled_at, 1.hour.ago)
      other_hold, = other.hold_sales!(seller:, held_by: admin)

      release(other_hold.external_id)

      expect(response.parsed_body["message"]).to eq("Sales hold not found")
      expect(other_hold.reload).to be_active
    end

    it "returns 422 for a product of another seller", parity: true do
      release(hold.external_id, user_id: create(:user, email: "other@example.com").external_id)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(hold.reload).to be_active
    end

    it "requires the seller's user_id", parity: true do
      release(hold.external_id, user_id: nil)

      expect(response).to have_http_status(:bad_request)
    end

    it "returns 404 for an unknown product", parity: true do
      release(hold.external_id, product_id: Link.to_external_id(listing.id + 1000))

      expect(response).to have_http_status(:not_found)
    end
  end
end
