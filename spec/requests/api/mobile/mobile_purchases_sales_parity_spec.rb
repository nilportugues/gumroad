# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile purchases and sales answers the Next.js port serves itself (nextjs/src/server/controllers/mobile-purchases.ts):
# the unconfirmed 403, the 404 for a purchase that is not the caller's, the empty listings and the sales rows whose
# Purchase#as_json(creator_app_api: true) is ported (USD, no recurrence, no uploaded thumbnail). The examples that end in
# `hands a ...` are the cases it leaves to Rails whole; the replay asserts Node forwards each one and writes nothing.
describe "Mobile API purchases and sales", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::MobileApi

  let(:buyer) { create(:user) }
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }

  def library_purchase
    purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful")
  end

  describe "purchases" do
    it "refuses an unconfirmed account", parity: true do
      unconfirmed = create(:user, confirmed_at: nil)

      get "/mobile/purchases/index", params: auth(unconfirmed)

      expect(response).to have_http_status(:forbidden)
    end

    it "lists nothing for a buyer without purchases", parity: true do
      get "/mobile/purchases/index", params: auth(buyer).merge(per_page: "500")

      expect(response.parsed_body["products"]).to eq([])
      expect(response.parsed_body["meta"]["pagination"]).to include("count" => 0, "items" => 100, "pages" => 1)
    end

    it "searches nothing for a buyer without purchases", parity: true do
      get "/mobile/purchases/search", params: auth(buyer).merge(q: "x", items: "3")

      expect(response.parsed_body).to include("purchases" => [], "sellers" => [])
    end

    it "does not find a purchase that belongs to someone else", parity: true do
      other = purchase_row(link: product, seller:, purchase_state: "successful")

      get "/mobile/purchases/purchase_attributes/#{other.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find purchase")
    end

    it "does not archive a purchase that belongs to someone else", parity: true do
      other = purchase_row(link: product, seller:, purchase_state: "successful")

      post "/mobile/purchases/#{other.external_id}/archive", params: auth(buyer)

      expect(response).to have_http_status(:not_found)
      expect(other.reload.is_archived).to eq(false)
    end

    it "does not delete a purchase that belongs to someone else", parity: true do
      other = purchase_row(link: product, seller:, purchase_state: "successful")

      delete "/mobile/purchases/#{other.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:not_found)
      expect(other.reload.is_deleted_by_buyer).to eq(false)
    end

    it "hands a library with purchases to Rails", parity: true do
      library_purchase

      get "/mobile/purchases/index", params: auth(buyer)

      expect(response.parsed_body["products"].size).to eq(1)
    end

    it "hands a read of the buyer's own purchase to Rails", parity: true do
      purchase = library_purchase

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
    end

    it "hands an archive of the buyer's own purchase to Rails", parity: true do
      purchase = create(:free_purchase, link: create(:product, user: seller, price_cents: 0), purchaser: buyer, email: buyer.email)

      post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

      expect(purchase.reload.is_archived).to eq(true)
    end
  end

  describe "sales" do
    before { Purchase.__elasticsearch__.create_index!(force: true) }

    it "lists nothing for a seller without sales", parity: true do
      get "/mobile/sales", params: auth(seller).merge(page: "3")

      expect(response.parsed_body).to eq("success" => true, "purchases" => [], "pagination" => { "count" => 0, "page" => 3, "pages" => 0, "next" => nil })
    end

    it "does not find a sale that belongs to another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      get "/mobile/sales/#{other.external_id}", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find purchase")
    end

    it "hands a read of the seller's own sale to Rails", parity: true do
      sale = library_purchase

      get "/mobile/sales/#{sale.external_id}", params: auth(seller)

      expect(response).to have_http_status(:ok)
    end

    it "serves a sales page of USD sales", parity: true do
      library_purchase
      purchase_row(link: product, seller:, purchase_state: "successful", price_cents: 0, email: "free@example.com")
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller)

      expect(response.parsed_body["purchases"].size).to eq(2)
      expect(response.parsed_body["pagination"]).to eq("count" => 2, "page" => 1, "pages" => 1, "next" => nil)
    end

    it "serves a sales page beyond the last page as an empty list", parity: true do
      library_purchase
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller).merge(page: "2")

      expect(response.parsed_body).to include("purchases" => [], "pagination" => { "count" => 1, "page" => 2, "pages" => 1, "next" => nil })
    end

    it "hands a sales page with a subscription sale to Rails", parity: true do
      membership = create(:membership_product, user: seller)
      purchase_row(link: membership, seller:, purchase_state: "successful", is_original_subscription_purchase: true, subscription: create(:subscription, link: membership, user: buyer))
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller)

      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    describe "removing a review response" do
      let(:sale) { library_purchase }

      it "removes the seller's reply to the review", parity: true do
        review = create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")
        reply = create(:product_review_response, product_review: review, user: seller, message: "Thank you")

        delete "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller)

        expect(response.parsed_body).to eq("success" => true)
        expect(ProductReviewResponse.exists?(reply.id)).to eq(false)
        expect(review.reload).to be_present
      end

      it "does not find a sale that belongs to another seller", parity: true do
        other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

        delete "/mobile/sales/#{other.external_id}/review_response", params: auth(seller)

        expect(response).to have_http_status(:not_found)
        expect(response.parsed_body["message"]).to eq("Could not find purchase")
      end

      it "does not find a response for a sale without a review", parity: true do
        delete "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller)

        expect(response).to have_http_status(:not_found)
        expect(response.parsed_body).to eq("success" => false, "message" => "Could not find review response")
      end

      it "does not find a response for a review that has no reply", parity: true do
        create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")

        delete "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller)

        expect(response).to have_http_status(:not_found)
        expect(response.parsed_body["message"]).to eq("Could not find review response")
      end

      it "hands a review response removal of a subscription sale to Rails", parity: true do
        membership = create(:membership_product, user: seller)
        recurring = purchase_row(link: membership, seller:, purchase_state: "successful", is_original_subscription_purchase: true, subscription: create(:subscription, link: membership, user: buyer))
        review = create(:product_review, purchase: recurring, link: membership, rating: 5, message: "Fine")
        create(:product_review_response, product_review: review, user: seller, message: "Thanks")

        delete "/mobile/sales/#{recurring.external_id}/review_response", params: auth(seller)

        expect(response).to have_http_status(:ok)
      end
    end

    it "hands a sales page with a sale in another currency to Rails", parity: true do
      purchase_row(link: product, seller:, purchase_state: "successful", displayed_price_currency_type: "eur")
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller)

      expect(response.parsed_body["purchases"].size).to eq(1)
    end
  end
end
