# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile purchases and sales answers the Next.js port serves itself (nextjs/src/server/controllers/mobile-purchases.ts):
# the unconfirmed 403, the 404 for a purchase that is not the caller's, and the empty listings. The examples that end in
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
      purchase = library_purchase

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

    it "hands a sales page with rows to Rails", parity: true do
      library_purchase
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller)

      expect(response.parsed_body["purchases"].size).to eq(1)
    end
  end
end
