# frozen_string_literal: true

require "spec_helper"

# GET /d/:id for a purchase whose content page lists nothing (no files, rich content, variants, posts or
# integrations), plus every redirect check_permissions can answer with. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/url-redirect-pages.replay.test.ts, which sends
# the last request of each example and compares the response, the url_redirects and consumption_events writes
# and the confirmed_redirect cookie.
describe "Url redirect download page", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Parity Seller") }
  let(:buyer) { create(:user, name: "Parity Buyer") }
  let(:product) { create(:product, user: seller, name: "Parity course").tap { |record| record.product_files.delete_all } }
  let(:purchase) do
    create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com").tap do |record|
      record.update_columns(price_cents: 500, total_transaction_cents: 500, ip_address: "203.0.113.9")
    end
  end
  let(:url_redirect) { create(:url_redirect, link: product, purchase:) }

  describe "GET /d/:id" do
    it "renders the content page and records the visit", parity: true do
      log_in(buyer)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("content" => include("content_items" => [], "posts" => []), "add_to_library_option" => "none")
      expect(url_redirect.reload).to have_attributes(uses: 1, has_been_seen: true)
      expect(ConsumptionEvent.where(url_redirect_id: url_redirect.id, event_type: "view").count).to eq(1)
    end

    it "echoes the saved content page id", parity: true do
      purchase.update_columns(json_data: { last_content_page_id: "saved-page-id" })
      log_in(buyer)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("content" => include("last_content_page_id" => "saved-page-id"))
    end

    it "redirects a coffee purchase to the seller's coffee page", parity: true do
      product.update_columns(native_type: Link::NATIVE_TYPE_COFFEE)
      seller.update_columns(username: "paritycoffee")
      log_in(buyer)

      get url_redirect_download_page_path(url_redirect.token, purchase_email: "buyer+1@example.com")

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/coffee?purchase_email=buyer%2B1%40example.com")
      expect(url_redirect.reload.uses).to eq(0)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(buyer)

      inertia_visit url_redirect_download_page_path(url_redirect.token, display: "mobile_app")

      expect(response).to be_successful
      expect(response.parsed_body.dig("props", "is_mobile_app_web_view")).to be(true)
    end

    it "offers a signed-out visitor the signup form for a guest purchase", parity: true do
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["add_to_library_option"]).to eq("signup_form")
    end

    it "renders a redirect without a purchase", parity: true do
      link_only = create(:url_redirect, link: product, purchase: nil)
      log_in(seller)

      get url_redirect_download_page_path(link_only.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]).to be_nil
    end

    it "asks for the purchase email once the link was opened", parity: true do
      url_redirect.mark_as_seen
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_download_page_path(url_redirect.token, display: "mobile_app")

      expect(response).to redirect_to(confirm_page_path(destination: "download_page", display: "mobile_app", id: url_redirect.token))
    end

    it "sends a signed-in stranger to the purchaser check", parity: true do
      log_in(create(:user, name: "Other Buyer"))

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_check_purchaser_path(url_redirect.token, next: url_redirect_download_page_path(url_redirect.token)))
    end

    it "sends a refunded purchase to a 404", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to have_http_status(:not_found)
    end

    it "sends an expired rental to the rental expired page", parity: true do
      purchase.update_columns(rental_expired: true)
      log_in(buyer)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_rental_expired_page_path(url_redirect.token))
    end

    it "sends revoked access to the expired page", parity: true do
      purchase.update_attribute(:is_access_revoked, true)
      log_in(buyer)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to redirect_to(url_redirect_expired_page_path(url_redirect.token))
    end

    it "sends a signed-out visitor of a test purchase to log in", parity: true do
      purchase.update_columns(purchaser_id: seller.id)

      get url_redirect_download_page_path(url_redirect.token)

      expect(response).to have_http_status(:redirect)
      expect(response.location).to include("/login?next=")
    end
  end
end
