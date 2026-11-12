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

    it "serves the buyer's own purchase with no product updates", parity: true do
      purchase = library_purchase

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["product"]).to include("purchase_id" => purchase.external_id, "product_updates_data" => [])
    end

    describe "refunds and reviews" do
      let(:purchase) { purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", price_cents: 500, stripe_partially_refunded: true) }

      def refund_row(amount_cents:, **attributes)
        build(:refund, purchase:, amount_cents:, **attributes).tap { |refund| refund.save!(validate: false) }
      end

      def product_json = response.parsed_body["product"]

      it "subtracts a partial refund from the refundable amount", parity: true do
        refund_row(amount_cents: 200)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(product_json).to include("amount_refundable_in_currency" => "3", "partially_refunded" => true, "refunded" => false)
      end

      it "sums several refunds and counts the refund with no amount as zero", parity: true do
        refund_row(amount_cents: 100)
        refund_row(amount_cents: 150)
        refund_row(amount_cents: 0).update_columns(amount_cents: nil)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(product_json["amount_refundable_in_currency"]).to eq("2.50")
      end

      it "leaves out a failed refund whose balance debits were reversed but keeps one that was not", parity: true do
        refund_row(amount_cents: 100, status: "failed", balance_reversed_on_failure: true)
        refund_row(amount_cents: 50, status: "canceled")
        refund_row(amount_cents: 25, status: "failed", balance_reversed_on_failure: false)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(product_json["amount_refundable_in_currency"]).to eq("4.25")
      end

      it "reports the rating of the purchase's review", parity: true do
        create(:product_review, purchase:, link: product, rating: 4)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(product_json).to include("product_rating" => 4)
      end

      it "reports a review that has no rating as null", parity: true do
        create(:product_review, purchase:, link: product, rating: 1).update_columns(rating: nil)

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(product_json).to include("product_rating" => nil)
      end

      it "hands a refund whose balance_reversed_on_failure is not a boolean to Rails", parity: true do
        refund_row(amount_cents: 100, status: "failed").update_columns(json_data: { balance_reversed_on_failure: "false" })

        get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

        expect(response).to have_http_status(:ok)
      end
    end

    it "does not find a refunded purchase", parity: true do
      purchase = purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", stripe_refunded: true)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find purchase")
    end

    it "hands a read of a purchase whose seller has a post to Rails", parity: true do
      purchase = library_purchase
      create(:installment, link: product, published_at: Time.current, shown_on_profile: true, send_emails: false)

      get "/mobile/purchases/purchase_attributes/#{purchase.external_id}", params: auth(buyer)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["product"]["product_updates_data"].size).to eq(1)
    end

    it "hands an archive of a purchase of a product with rich content to Rails", parity: true do
      purchase = create(:free_purchase, link: create(:product, user: seller, price_cents: 0), purchaser: buyer, email: buyer.email)
      create(:url_redirect, purchase:, link: purchase.link)
      create(:rich_content, entity: purchase.link, description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Hello" }] }])

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

  describe "sale options" do
    def sale_of(link) = purchase_row(link:, seller:, purchase_state: "successful")

    it "does not find a sale that belongs to another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      get "/mobile/sales/#{other.external_id}/options", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find purchase")
    end

    it "lists no options for a product without versions", parity: true do
      get "/mobile/sales/#{sale_of(product).external_id}/options", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "options" => [])
    end

    it "lists the alive versions of the first version category in position order", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      create(:variant, variant_category: category, name: "Deluxe", price_difference_cents: 500, description: "Everything", position_in_category: 1)
      create(:variant, variant_category: category, name: "Basic", price_difference_cents: 0, max_purchase_count: 10, position_in_category: 0)
      create(:variant, variant_category: category, name: "Untitled", price_difference_cents: 100, customizable_price: true, position_in_category: 2)
      create(:variant, variant_category: category, name: "Retired", position_in_category: 3).mark_deleted!
      other_category = create(:variant_category, link: product, title: "Color")
      create(:variant, variant_category: other_category, name: "Red")

      get "/mobile/sales/#{sale_of(product).external_id}/options", params: auth(seller)

      expect(response.parsed_body["options"].map { _1["name"] }).to eq(["Basic", "Deluxe", product.name])
    end

    it "lists the tiers of a membership with their recurrence prices", parity: true do
      membership = create(:membership_product, user: seller)

      get "/mobile/sales/#{sale_of(membership).external_id}/options", params: auth(seller)

      expect(response.parsed_body["options"].first["recurrence_price_values"]).to include("monthly")
    end

    it "lists the alive SKUs of a product that sells by SKU", parity: true do
      physical = create(:physical_product, user: seller, skus_enabled: true)
      create(:sku, link: physical, name: "Standard - Large")
      create(:sku, link: physical, name: "Standard - Small").mark_deleted!

      get "/mobile/sales/#{sale_of(physical).external_id}/options", params: auth(seller)

      expect(response.parsed_body["options"].map { _1["name"] }).to eq(["Standard - Large"])
    end
  end
end
