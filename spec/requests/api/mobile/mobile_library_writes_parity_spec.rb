# frozen_string_literal: true

require "spec_helper"

# Api::Mobile::PurchasesController#archive, #unarchive and #destroy for a plain purchase (no url redirect, subscription or gift), which the Next.js port writes itself (nextjs/src/server/controllers/mobile-purchases.ts). `parity_timeline`
# records the order of the statements and jobs inside each write. The examples that end in `hands a ...` are the purchases it
# leaves to Rails whole; the replay asserts Node forwards each one and writes nothing.
describe "Mobile API library writes", type: :request, parity_timeline: true do
  include Parity::MobileApi

  let(:buyer) { create(:user) }
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }
  let(:merchant_account) { create(:merchant_account, user: seller) }

  # `save!` revalidates the row, and a paid purchase is only valid with its processor details.
  def paid_purchase(**attributes)
    purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", stripe_transaction_id: "ch_#{SecureRandom.hex(6)}", stripe_fingerprint: "fp_library", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:, **attributes)
  end

  let(:purchase) { paid_purchase }

  it "archives the buyer's purchase", parity: true do
    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["product"]).to include("purchase_id" => purchase.external_id, "is_archived" => true)
    expect(purchase.reload.is_archived).to eq(true)
  end

  it "unarchives an archived purchase", parity: true do
    purchase.update_column(:flags, purchase.flags | Purchase.flag_mapping["flags"][:is_archived])

    post "/mobile/purchases/#{purchase.external_id}/unarchive", params: auth(buyer)

    expect(response.parsed_body["product"]).to include("is_archived" => false)
    expect(purchase.reload.is_archived).to eq(false)
  end

  it "archives a purchase that is already archived", parity: true do
    purchase.update_column(:flags, purchase.flags | Purchase.flag_mapping["flags"][:is_archived])

    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response.parsed_body["product"]).to include("is_archived" => true)
  end

  it "deletes the purchase from the library", parity: true do
    delete "/mobile/purchases/#{purchase.external_id}", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["product"]).to include("purchase_id" => purchase.external_id)
    expect(purchase.reload.is_deleted_by_buyer).to eq(true)
  end

  it "archives an older purchase of a seller in another time zone", parity: true do
    seller.update!(timezone: "Tokyo")
    older = paid_purchase(created_at: 3.days.ago)

    post "/mobile/purchases/#{older.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(older.reload.is_archived).to eq(true)
  end

  it "does not find a refunded purchase to archive", parity: true do
    refunded = paid_purchase(stripe_refunded: true)

    post "/mobile/purchases/#{refunded.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:not_found)
    expect(refunded.reload.is_archived).to eq(false)
  end

  describe "with a url redirect" do
    let!(:pdf) { create(:readable_document, link: product, position: 1) }
    let!(:video) { create(:streamable_video, link: product, position: 0) }
    let!(:link_file) { create(:product_file, link: product, url: "https://example.com/page", filetype: "link", filegroup: "url", position: 2) }
    let!(:redirect) { create(:url_redirect, purchase:, link: product) }

    it "reads the purchase with its files", parity: true do
      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response.parsed_body["product"]).to include("url_redirect_token" => redirect.token)
      expect(response.parsed_body["product"]["file_data"].size).to eq(3)
    end

    it "reads the purchase of a product whose main cover is a player with a thumbnail", parity: true do
      create(:asset_preview, attach: false, link: product, guid: "mobilereadplayer", oembed: {
        "html" => "<iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" }
      })

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response.parsed_body["product"]).to include("preview_url" => "https://example.com/thumb.png", "preview_oembed_url" => "", "preview_width" => 640)
    end

    it "hands a purchase of a product with an uploaded cover to Rails", parity: true do
      create(:asset_preview_jpg, link: product, guid: "mobilereadupload")

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
    end

    it "archives the purchase and answers with its files", parity: true do
      post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

      expect(response.parsed_body["product"]).to include("is_archived" => true, "url_redirect_external_id" => redirect.external_id)
    end

    it "leaves out the download url of a stream-only file", parity: true do
      video.update_columns(flags: video.flags | ProductFile.flag_mapping["flags"][:stream_only])

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
    end

    def location_for(file, **attributes)
      create(:media_location, purchase_id: purchase.id, product_id: product.id, url_redirect_id: redirect.id, product_file_id: file.id, platform: "web", **attributes)
    end

    def file_json(file) = response.parsed_body["product"]["file_data"].find { _1["id"] == file.external_id }

    it "reads the page a reader stopped at in a pdf", parity: true do
      location_for(pdf, location: 2)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(file_json(pdf)["latest_media_location"]).to include("location" => 2, "unit" => "page_number")
    end

    it "reads only the latest location of a file", parity: true do
      location_for(pdf, location: 1, consumed_at: 3.hours.ago)
      location_for(pdf, location: 5, consumed_at: 1.hour.ago)
      location_for(pdf, location: 3, consumed_at: 2.hours.ago)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(file_json(pdf)["latest_media_location"]).to include("location" => 5)
    end

    it "reads the seconds a viewer reached in a video", parity: true do
      location_for(video, location: 42)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(file_json(video)["latest_media_location"]).to include("location" => 42, "unit" => "seconds")
    end

    it "leaves out a location in a unit the file cannot use", parity: true do
      location_for(pdf, location: 2).update_columns(unit: "seconds")

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(file_json(pdf)["latest_media_location"]).to be_nil
    end

    it "archives the purchase and answers with the media location", parity: true do
      location_for(pdf, location: 4)

      post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

      expect(file_json(pdf)["latest_media_location"]).to include("location" => 4)
    end

    it "hands a pair of locations that share the latest consumed_at to Rails", parity: true do
      moment = 2.hours.ago
      location_for(pdf, location: 1, consumed_at: moment)
      location_for(pdf, location: 2, consumed_at: moment)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
    end

    describe "with an epub" do
      let!(:epub) { create(:epub_product_file, link: product, position: 3).tap { _1.update_columns(pagelength: 10) } }

      def epub_location(percentage, spine_step, **attributes)
        location_for(epub, location: percentage, epub_cfi: "epubcfi(/6/#{spine_step}[chapter]!/4/2/1:0)", unit: "percentage", **attributes)
      end

      it "reads an epub position as a page and as an epub location", parity: true do
        epub_location(50, 8)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(file_json(epub)["latest_media_location"]).to include("location" => 4, "unit" => "page_number")
        expect(file_json(epub)["latest_epub_location"]).to include("page_number" => 4, "completed" => false, "percentage" => 50)
      end

      it "reads a finished epub as its last page", parity: true do
        epub_location(100, 20)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(file_json(epub)["latest_media_location"]).to include("location" => 10)
        expect(file_json(epub)["latest_epub_location"]).to include("completed" => true)
      end

      it "steps back from the last page of an epub that is not finished", parity: true do
        epub_location(95, 20).update_columns(location: 95)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(file_json(epub)["latest_media_location"]).to include("location" => 9)
      end

      it "leaves out an epub position on an odd spine step", parity: true do
        epub_location(50, 7)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(file_json(epub)["latest_media_location"]).to be_nil
        expect(file_json(epub)["latest_epub_location"]).to be_nil
      end

      it "reads a page-number location of an epub as a page", parity: true do
        location_for(epub, location: 3, unit: "page_number")

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(file_json(epub)["latest_media_location"]).to include("location" => 3, "unit" => "page_number")
        expect(file_json(epub)["latest_epub_location"]).to be_nil
      end
    end
  end

  describe "with a preorder" do
    let(:preorder_product) { create(:product, user: seller, price_cents: 600, is_in_preorder_state: true) }
    let(:preorder_link) { create(:preorder_link, link: preorder_product, release_at: Time.utc(2030, 1, 15, 12)) }
    let(:preorder) { create(:preorder, preorder_link:, seller:, purchaser: buyer, state: "authorization_successful") }
    let!(:authorization) do
      purchase_row(:preorder_authorization_purchase, link: preorder_product, seller:, purchaser: buyer, email: buyer.email, preorder:, is_preorder_authorization: true, stripe_transaction_id: "ch_#{SecureRandom.hex(6)}", stripe_fingerprint: "fp_library", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:)
    end

    it "archives the authorization purchase and answers with the release date", parity: true do
      post "/mobile/purchases/#{authorization.external_id}/archive", params: auth(buyer)

      expect(response.parsed_body["product"]).to include("is_archived" => true, "preorder_data" => { "external_id" => preorder.external_id, "release_at" => "2030-01-15T12:00:00Z" })
      expect(authorization.reload.is_archived).to eq(true)
    end

    it "deletes the authorization purchase from the library", parity: true do
      delete "/mobile/purchases/#{authorization.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
      expect(authorization.reload.is_deleted_by_buyer).to eq(true)
    end

    it "hands an archive of a preorder whose charge purchase has a url redirect to Rails", parity: true do
      charge = purchase_row(link: preorder_product, seller:, purchaser: buyer, email: buyer.email, preorder:, purchase_state: "successful", stripe_transaction_id: "ch_#{SecureRandom.hex(6)}", stripe_fingerprint: "fp_library", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:)
      create(:url_redirect, purchase: charge, link: preorder_product)

      post "/mobile/purchases/#{authorization.external_id}/archive", params: auth(buyer)

      expect(response.parsed_body["product"]).to include("url_redirect_token" => be_present)
      expect(authorization.reload.is_archived).to eq(true)
    end
  end

  it "hands an archive of a purchase whose seller has a post to Rails", parity: true do
    create(:installment, link: product, published_at: Time.current, shown_on_profile: true, send_emails: false)

    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(purchase.reload.is_archived).to eq(true)
  end
end
