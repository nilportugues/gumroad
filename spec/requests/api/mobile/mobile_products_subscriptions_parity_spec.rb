# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile products, subscriptions, preorders and installments answers the Next.js port serves itself
# (nextjs/src/server/controllers/mobile-{products,subscriptions,preorders,installments}.ts): the products listing, the 404s, and the
# subscription payload of a USD membership whose seller has no posts. The examples that end in `hands a ...` are the cases it leaves to
# Rails whole; the replay asserts Node forwards each one and writes nothing.
describe "Mobile API products, subscriptions, preorders and installments", type: :request do
  include Parity::MobileApi

  let(:seller) { create(:user) }

  describe "products" do
    it "lists the seller's visible products newest first", parity: true do
      older = create(:product, user: seller, name: "Older course", created_at: 2.days.ago)
      newer = create(:product, user: seller, name: "Newer course", created_at: 1.day.ago)
      create(:product, name: "Someone else's")
      create(:product, user: seller, name: "Archived").update!(archived: true)
      create(:product, user: seller, name: "Deleted").mark_deleted!

      get "/mobile/products", params: auth(seller)

      expect(response.parsed_body["products"].map { _1["id"] }).to eq([newer.unique_permalink, older.unique_permalink])
      expect(response.parsed_body["pagination"]).to eq("count" => 2, "page" => 1, "pages" => 1, "next" => nil)
    end

    it "filters products by name", parity: true do
      create(:product, user: seller, name: "Photo pack")
      match = create(:product, user: seller, name: "Writing guide")

      get "/mobile/products", params: auth(seller).merge(query: "writing")

      expect(response.parsed_body["products"].map { _1["id"] }).to eq([match.unique_permalink])
    end

    it "lists nothing for a seller without products", parity: true do
      get "/mobile/products", params: auth(seller)

      expect(response.parsed_body).to include("products" => [], "pagination" => { "count" => 0, "page" => 1, "pages" => 1, "next" => nil })
    end

    it "refuses a token without the mobile_api scope", parity: true do
      get "/mobile/products", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
    end

    it "answers a 400 for a page past the last one", parity: true do
      create(:product, user: seller)

      get "/mobile/products", params: auth(seller).merge(page: "9")

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a delete to Rails", parity: true do
      product = create(:product, user: seller)

      delete "/mobile/products/#{product.unique_permalink}", params: auth(seller)

      expect(response).to be_successful
      expect(product.reload.deleted?).to eq(true)
    end
  end

  describe "subscriptions" do
    let(:product) { create(:subscription_product, user: seller) }
    let(:buyer) { create(:user) }
    let(:subscription) { create(:subscription, link: product, user: buyer) }

    before do
      purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, subscription:, is_original_subscription_purchase: true, purchase_state: "successful")
    end

    it "does not find a dead subscription", parity: true do
      subscription.cancel_effective_immediately!

      get "/mobile/subscriptions/subscription_attributes/#{subscription.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find subscription")
    end

    it "does not find an unknown subscription", parity: true do
      get "/mobile/subscriptions/subscription_attributes/xxx", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
    end

    it "serves the payload of a live subscription", parity: true do
      get "/mobile/subscriptions/subscription_attributes/#{subscription.external_id}", params: { mobile_token: }

      expect(response.parsed_body["subscription"]).to include("updates_data" => [], "purchase_id" => be_present)
    end

    it "hands a subscription whose seller has posts to Rails", parity: true do
      create(:installment, link: product, published_at: Time.current)

      get "/mobile/subscriptions/subscription_attributes/#{subscription.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:ok)
    end

    it "hands a cancel to Rails", parity: true do
      post "/mobile/subscriptions/#{subscription.external_id}/cancel", params: auth(seller)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "preorders" do
    it "does not find an unknown preorder", parity: true do
      get "/mobile/preorders/preorder_attributes/xxx", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find preorder")
    end

    describe "an authorized preorder" do
      let(:buyer) { create(:user) }
      let(:product) { create(:product, user: seller, price_cents: 600, is_in_preorder_state: true) }
      let(:preorder_link) { create(:preorder_link, link: product, release_at: Time.utc(2030, 1, 15, 12)) }
      let(:preorder) { create(:preorder, preorder_link:, seller:, purchaser: buyer, state: "authorization_successful") }

      before do
        purchase_row(:preorder_authorization_purchase, link: product, seller:, purchaser: buyer, email: buyer.email, preorder:, is_preorder_authorization: true)
      end

      it "serves the authorization purchase and the release date", parity: true do
        get "/mobile/preorders/preorder_attributes/#{preorder.external_id}", params: { mobile_token: }

        expect(response.parsed_body["product"]).to include(
          "name" => product.name,
          "purchase_id" => be_present,
          "product_updates_data" => [],
          "is_archived" => false,
          "preorder_data" => { "external_id" => preorder.external_id, "release_at" => "2030-01-15T12:00:00Z" }
        )
      end

      it "serves an archived authorization purchase", parity: true do
        preorder.purchases.first.update_columns(flags: preorder.purchases.first.flags | (1 << 16))

        get "/mobile/preorders/preorder_attributes/#{preorder.external_id}", params: { mobile_token: }

        expect(response.parsed_body["product"]).to include("is_archived" => true)
      end

      it "hands a preorder whose seller has posts to Rails", parity: true do
        create(:installment, link: product, published_at: Time.current)

        get "/mobile/preorders/preorder_attributes/#{preorder.external_id}", params: { mobile_token: }

        expect(response).to have_http_status(:ok)
      end
    end
  end

  describe "installments" do
    let(:product) { create(:product, user: seller) }
    let(:post_row) { create(:installment, link: product, published_at: Time.current) }

    it "does not find an unknown installment", parity: true do
      get "/mobile/installments/xxx", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find installment")
    end

    it "does not find the related object when none is given", parity: true do
      get "/mobile/installments/#{post_row.external_id}", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Could not find related object to the installment.")
    end

    it "does not find the related object when the purchase does not exist", parity: true do
      get "/mobile/installments/#{post_row.external_id}", params: { mobile_token:, purchase_id: "xxx" }

      expect(response).to have_http_status(:not_found)
    end

    it "hands an installment with a follower to Rails", parity: true do
      follower = create(:follower)

      get "/mobile/installments/#{post_row.external_id}", params: { mobile_token:, follower_id: follower.external_id }

      expect(response).to have_http_status(:ok)
    end
  end
end
