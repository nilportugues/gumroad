# frozen_string_literal: true

require "spec_helper"

# The access gate in front of UrlRedirectsController's delivery actions (show, stream, read, play, hls_playlist, download_archive,
# download_product_files, download_subtitle_file, subtitle_file_vtt, smil): check_permissions and require_seller_for_test_purchase.
# Only requests the gate refuses are recorded, since Next.js hands every request that passes to Rails (it signs the S3 or
# CloudFront URL, builds the playlist or props, and writes the use count, consumption event or rental stamp). Recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/url-redirect-pages.replay.test.ts, which sends the last request of
# each example and compares the response.
describe "Url redirect delivery gate", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Parity Seller") }
  let(:buyer) { create(:user, name: "Parity Buyer") }
  let(:product) { create(:product, user: seller, name: "Parity course") }
  let(:purchase) do
    create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com").tap do |record|
      record.update_columns(price_cents: 500, total_transaction_cents: 500, ip_address: "203.0.113.9")
    end
  end
  let(:url_redirect) { create(:url_redirect, link: product, purchase:) }
  let(:product_file) { product.product_files.alive.first }

  describe "GET /r/:id" do
    it "sends a refunded purchase to a 404", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get url_redirect_path(url_redirect.token)

      expect(response).to have_http_status(:not_found)
    end

    it "sends an expired rental to the rental expired page", parity: true do
      purchase.update_columns(rental_expired: true)
      log_in(buyer)

      get url_redirect_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_rental_expired_page_path(url_redirect.token))
    end

    it "sends revoked access to the expired page", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(buyer)

      get url_redirect_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_expired_page_path(url_redirect.token))
    end

    it "sends a signed-in stranger to the purchaser check", parity: true do
      log_in(create(:user, name: "Other Buyer"))

      get url_redirect_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_check_purchaser_path(url_redirect.token, next: url_redirect_path(url_redirect.token)))
    end

    it "asks for the purchase email once the link was opened, naming the action", parity: true do
      url_redirect.mark_as_seen
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_path(url_redirect.token)

      expect(response).to redirect_to(confirm_page_path(destination: "show", id: url_redirect.token))
    end

    it "sends a signed-out visitor of a test purchase to log in", parity: true do
      purchase.update_columns(purchaser_id: seller.id)

      get url_redirect_path(url_redirect.token)

      expect(response).to have_http_status(:redirect)
      expect(response.location).to include("/login?next=")
    end

    it "answers 404 for an unknown token", parity: true do
      get url_redirect_path("unknown-token")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /r/:id/product_files" do
    it "sends revoked access to the expired page", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(buyer)

      get url_redirect_download_product_files_path(url_redirect.token, product_file_ids: [product_file.external_id])

      expect(response).to redirect_to(url_redirect_expired_page_path(url_redirect.token))
    end
  end

  describe "GET /zip/:id" do
    it "sends an inactive membership to the membership inactive page", parity: true do
      subscription = create(:subscription, link: product, user: buyer, cancelled_at: 1.day.ago)
      product.update!(block_access_after_membership_cancellation: true)
      purchase.update_columns(subscription_id: subscription.id)
      log_in(buyer)

      get url_redirect_download_archive_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_membership_inactive_page_path(url_redirect.token))
    end
  end

  describe "GET /s/:id" do
    it "asks for the purchase email once the link was opened, naming the action", parity: true do
      url_redirect.mark_as_seen
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_stream_page_path(url_redirect.token)

      expect(response).to redirect_to(confirm_page_path(destination: "stream", id: url_redirect.token))
    end
  end

  describe "GET /read/:id" do
    it "sends a refused read to the home page when signed out", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get url_redirect_read_path(url_redirect.token)

      expect(response).to redirect_to(root_path)
    end

    it "sends a refused read to the library when signed in", parity: true do
      purchase.update_columns(stripe_refunded: true)
      log_in(buyer)

      get url_redirect_read_path(url_redirect.token)

      expect(response).to redirect_to(library_path)
    end

    it "sends an unknown token to the home page", parity: true do
      get url_redirect_read_path("unknown-token")

      expect(response).to redirect_to(root_path)
    end
  end

  describe "GET /d/:id/play" do
    it "sends revoked access to the expired page", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(buyer)

      get url_redirect_play_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_expired_page_path(url_redirect.token))
    end

    it "answers 404 for a redirect without a purchase", parity: true do
      link_only = create(:url_redirect, link: product)
      log_in(seller)

      get url_redirect_play_path(link_only.token)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /r/:id/:product_file_id/index.m3u8" do
    it "sends a refunded purchase to a 404", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get hls_playlist_for_product_file_path(url_redirect.token, product_file.external_id)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /r/:id/:product_file_id/stream.smil" do
    it "answers 404 for a test purchase opened by anyone but its buyer", parity: true do
      purchase.update_columns(purchaser_id: seller.id)

      get url_redirect_smil_for_product_file_path(url_redirect.token, product_file.external_id)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /r/:id/:product_file_id/:subtitle_file_id" do
    it "sends revoked access to the expired page", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(buyer)

      get url_redirect_download_subtitle_file_path(url_redirect.token, product_file.external_id, "subtitle")

      expect(response).to redirect_to(url_redirect_expired_page_path(url_redirect.token))
    end
  end
end
