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

    it "lists a library with one purchase", parity: true do
      library_purchase

      get "/mobile/purchases/index", params: auth(buyer)

      expect(response.parsed_body["products"].size).to eq(1)
    end

    describe "the library listing" do
      let(:other_seller) { create(:user, name: "Other Seller") }
      let(:alpha) { create(:product, user: seller, name: "Alpha guide") }
      let(:beta) { create(:product, user: seller, name: "Beta 100%_pack") }

      def listed(link, **attributes)
        purchase_row(link:, seller: link.user, purchaser: buyer, email: buyer.email, purchase_state: "successful", **attributes)
      end

      def listed_ids(key = "products") = response.parsed_body[key].map { _1["purchase_id"] }

      it "lists the buyer's purchases newest first and leaves out the ones the library hides", parity: true do
        older = listed(alpha, created_at: 5.hours.ago)
        newer = listed(beta, created_at: 2.hours.ago)
        archived = listed(alpha, created_at: 3.hours.ago, flags: Purchase.flag_mapping["flags"][:is_archived])
        listed(alpha, is_deleted_by_buyer: true)
        listed(alpha, stripe_refunded: true)
        listed(alpha, purchase_state: "failed")
        purchase_row(link: alpha, seller:, purchase_state: "successful", email: "other@example.com")

        get "/mobile/purchases/index", params: auth(buyer)

        expect(listed_ids).to eq([newer, archived, older].sort_by { -_1.id }.map(&:external_id))
        expect(response.parsed_body["meta"]["pagination"]).to include("count" => 3, "items" => 100, "pages" => 1)
      end

      it "pages through the library", parity: true do
        rows = Array.new(3) { |n| listed(alpha, created_at: (n + 1).hours.ago) }

        get "/mobile/purchases/index", params: auth(buyer).merge(per_page: "2", page: "2")

        expect(listed_ids).to eq([rows.min_by(&:id).external_id])
        expect(response.parsed_body["meta"]["pagination"]).to include("count" => 3, "items" => 2, "page" => 2, "pages" => 2, "prev" => 1, "next" => nil, "last" => 2)
      end

      it "lists the files of a purchase with a url redirect", parity: true do
        purchase = listed(alpha)
        create(:readable_document, link: alpha, position: 0)
        create(:url_redirect, purchase:, link: alpha)

        get "/mobile/purchases/index", params: auth(buyer)

        expect(response.parsed_body["products"].first["file_data"].size).to eq(1)
      end

      it "answers a 400 for a library page past the last", parity: true do
        listed(alpha)

        get "/mobile/purchases/index", params: auth(buyer).merge(page: "3")

        expect(response).to have_http_status(:bad_request)
        expect(response.parsed_body["error"]["message"]).to eq("expected :page in 1..1; got 3")
      end

      it "answers a 400 for a library page below the first", parity: true do
        listed(alpha)

        get "/mobile/purchases/index", params: auth(buyer).merge(page: "0")

        expect(response).to have_http_status(:bad_request)
      end

      it "answers a 400 for a library page past the last of an empty library", parity: true do
        get "/mobile/purchases/index", params: auth(buyer).merge(page: "2", per_page: "1")

        expect(response).to have_http_status(:bad_request)
      end

      it "answers a 400 for a search page past the last", parity: true do
        listed(alpha)

        get "/mobile/purchases/search", params: auth(buyer).merge(page: "2", items: "5")

        expect(response).to have_http_status(:bad_request)
        expect(response.parsed_body["error"]["message"]).to eq("expected :page in 1..1; got 2")
      end

      it "answers a 400 for a search with no items to a page", parity: true do
        listed(alpha)

        get "/mobile/purchases/search", params: auth(buyer).merge(items: "0")

        expect(response).to have_http_status(:bad_request)
      end

      it "lists a library with a membership", parity: true do
        membership = create(:membership_product, user: seller)
        purchase_row(link: membership, seller:, purchase_state: "successful", is_original_subscription_purchase: true, subscription: create(:subscription, link: membership, user: buyer), purchaser: buyer, email: buyer.email)

        get "/mobile/purchases/index", params: auth(buyer)

        expect(response.parsed_body["products"].size).to eq(1)
      end

      it "hands a library with a post to show to Rails", parity: true do
        listed(alpha)
        create(:installment, link: alpha, published_at: Time.current, shown_on_profile: true, send_emails: false)

        get "/mobile/purchases/index", params: auth(buyer)

        expect(response.parsed_body["products"].first["product_updates_data"].size).to eq(1)
      end

      it "searches by product name, matching a percent sign and an underscore literally", parity: true do
        listed(alpha)
        listed(create(:product, user: seller, name: "Gamma 1009x"))
        match = listed(beta)

        get "/mobile/purchases/search", params: auth(buyer).merge(q: "100%_")

        expect(listed_ids("purchases")).to eq([match.external_id])
        expect(response.parsed_body["sellers"]).to eq([{ "id" => seller.external_id, "name" => seller.name, "purchases_count" => 1 }])
      end

      it "searches by seller name without product updates", parity: true do
        listed(alpha)
        other_product = create(:product, user: other_seller, name: "Gamma")
        match = listed(other_product)

        get "/mobile/purchases/search", params: auth(buyer).merge(q: "other sel")

        expect(listed_ids("purchases")).to eq([match.external_id])
        expect(response.parsed_body["purchases"].first).not_to have_key("product_updates_data")
        expect(response.parsed_body["sellers"].first).to include("id" => other_seller.external_id, "purchases_count" => 1)
      end

      it "filters by seller", parity: true do
        listed(alpha)
        match = listed(create(:product, user: other_seller))

        get "/mobile/purchases/search", params: auth(buyer).merge(seller: other_seller.external_id)

        expect(listed_ids("purchases")).to eq([match.external_id])
      end

      it "finds nothing for a seller that does not exist", parity: true do
        listed(alpha)

        get "/mobile/purchases/search", params: auth(buyer).merge(seller: "nobody")

        expect(response.parsed_body).to include("purchases" => [], "sellers" => [])
      end

      it "filters archived purchases", parity: true do
        listed(alpha, created_at: 2.hours.ago)
        archived = listed(alpha, created_at: 1.hour.ago, flags: Purchase.flag_mapping["flags"][:is_archived])

        get "/mobile/purchases/search", params: auth(buyer).merge(archived: "true")

        expect(listed_ids("purchases")).to eq([archived.external_id])
      end

      it "filters active purchases when archived is a false word", parity: true do
        active = listed(alpha, created_at: 2.hours.ago)
        listed(alpha, created_at: 1.hour.ago, flags: Purchase.flag_mapping["flags"][:is_archived])

        get "/mobile/purchases/search", params: auth(buyer).merge(archived: "off")

        expect(listed_ids("purchases")).to eq([active.external_id])
      end

      it "filters by purchase id", parity: true do
        listed(alpha)
        match = listed(beta)

        get "/mobile/purchases/search", params: auth(buyer).merge(purchase_ids: match.external_id)

        expect(listed_ids("purchases")).to eq([match.external_id])
      end

      it "finds nothing for a purchase id it cannot decode", parity: true do
        listed(alpha)

        get "/mobile/purchases/search", params: auth(buyer).merge(purchase_ids: "garbage")

        expect(response.parsed_body["purchases"]).to eq([])
      end

      it "orders by date ascending and pages with items", parity: true do
        rows = Array.new(3) { |n| listed(alpha, created_at: (3 - n).hours.ago) }

        get "/mobile/purchases/search", params: auth(buyer).merge(order: "date-asc", items: "2", page: "2")

        expect(listed_ids("purchases")).to eq([rows.last.external_id])
        expect(response.parsed_body["meta"]["pagination"]).to include("count" => 3, "items" => 2, "page" => 2, "pages" => 2)
      end

      it "orders an unknown order by id descending", parity: true do
        older = listed(alpha, created_at: 1.hour.ago)
        newer = listed(alpha, created_at: 3.hours.ago)

        get "/mobile/purchases/search", params: auth(buyer).merge(order: "bogus")

        expect(listed_ids("purchases")).to eq([newer, older].sort_by { -_1.id }.map(&:external_id))
      end

      it "hands a search over purchases of several sellers to Rails", parity: true do
        listed(alpha)
        listed(create(:product, user: other_seller))

        get "/mobile/purchases/search", params: auth(buyer)

        expect(response.parsed_body["sellers"].size).to eq(2)
      end
    end

    describe "memberships" do
      let(:membership) { create(:membership_product, user: seller) }
      let(:subscription) { create(:subscription, link: membership, user: buyer) }
      let(:original) { purchase_row(link: membership, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", is_original_subscription_purchase: true, subscription:) }

      def product_json = response.parsed_body["product"]

      it "reads a live membership with its subscription data", parity: true do
        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json["subscription_data"]).to eq("id" => subscription.external_id, "subscribed_at" => subscription.created_at.as_json, "ended_at" => nil, "ended_reason" => nil)
      end

      it "reports a cancelled membership as cancelled", parity: true do
        subscription.update_columns(cancelled_at: 2.hours.ago, deactivated_at: 2.hours.ago)

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json["subscription_data"]).to include("ended_reason" => "cancelled")
        expect(product_json["subscription_data"]["ended_at"]).to be_present
      end

      it "reports a membership whose payment failed", parity: true do
        subscription.update_columns(failed_at: 3.hours.ago, deactivated_at: 3.hours.ago)

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json["subscription_data"]).to include("ended_reason" => "failed_payment")
      end

      it "reports a membership that reached its end", parity: true do
        subscription.update_columns(ended_at: 4.hours.ago, deactivated_at: 4.hours.ago)

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json["subscription_data"]).to include("ended_reason" => "fixed_subscription_period_ended")
      end

      it "hands a membership whose cancellation is still in the future to Rails", parity: true do
        create(:url_redirect, purchase: original, link: membership)
        subscription.update_columns(cancelled_at: 3.days.from_now)

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json).to have_key("file_data")
      end

      it "leaves file_data out for a membership that ended", parity: true do
        create(:url_redirect, purchase: original, link: membership)
        subscription.update_columns(ended_at: 4.hours.ago, deactivated_at: 4.hours.ago)

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json).to include("url_redirect_token" => be_present)
        expect(product_json).not_to have_key("file_data")
      end

      it "reads the review of the original purchase from a renewal", parity: true do
        create(:product_review, purchase: original, link: membership, rating: 3)
        renewal = purchase_row(link: membership, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", subscription:)

        get "/mobile/purchases/purchase_attributes/#{renewal.external_id}", params: auth(buyer)

        expect(product_json).to include("product_rating" => 3, "purchase_id" => renewal.external_id)
      end

      it "reads a refunded renewal of a cancelled membership", parity: true do
        original
        subscription.update_columns(cancelled_at: 1.hour.ago, deactivated_at: 1.hour.ago)
        renewal = purchase_row(link: membership, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", subscription:, stripe_refunded: true)

        get "/mobile/purchases/purchase_attributes/#{renewal.external_id}", params: auth(buyer)

        expect(product_json).to include("refunded" => true)
      end

      it "hands a live membership with files and a tier to Rails", parity: true do
        create(:readable_document, link: membership, position: 0)
        create(:url_redirect, purchase: original, link: membership)
        original.variant_attributes << membership.tiers.first

        get "/mobile/purchases/purchase_attributes/#{original.external_id}", params: auth(buyer)

        expect(product_json).to have_key("file_data")
      end
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

    describe "preorders" do
      let(:preorder_product) { create(:product, user: seller, price_cents: 600, is_in_preorder_state: true) }
      let(:preorder_link) { create(:preorder_link, link: preorder_product, release_at: Time.utc(2030, 1, 15, 12)) }
      let(:preorder) { create(:preorder, preorder_link:, seller:, purchaser: buyer, state: "authorization_successful") }
      let!(:authorization) { purchase_row(:preorder_authorization_purchase, link: preorder_product, seller:, purchaser: buyer, email: buyer.email, preorder:, is_preorder_authorization: true) }

      def charge_purchase(**attributes)
        purchase_row(link: preorder_product, seller:, purchaser: buyer, email: buyer.email, preorder:, purchase_state: "successful", **attributes)
      end

      it "reads the authorization purchase of a preorder with its release date", parity: true do
        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("purchase_id" => authorization.external_id, "preorder_data" => { "external_id" => preorder.external_id, "release_at" => "2030-01-15T12:00:00Z" })
      end

      it "reads the preorder of a purchase made by a buyer with a name and an archived authorization", parity: true do
        authorization.update_columns(flags: authorization.flags | Purchase.flag_mapping["flags"][:is_archived], full_name: "  Preorder Buyer ")

        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("is_archived" => true, "full_name" => "Preorder Buyer")
      end

      it "reads a preorder whose latest purchase failed as the authorization", parity: true do
        purchase_row(link: preorder_product, seller:, purchaser: buyer, email: buyer.email, preorder:, purchase_state: "failed")

        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("purchase_id" => authorization.external_id)
        expect(response.parsed_body["product"]).to have_key("preorder_data")
      end

      it "reads the charge purchase of a preorder from the charge purchase itself", parity: true do
        charge = charge_purchase

        get "/mobile/purchases/purchase_attributes/#{charge.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("purchase_id" => charge.external_id)
        expect(response.parsed_body["product"]).not_to have_key("preorder_data")
        expect(response.parsed_body["product"]).not_to have_key("custom_delivery_url")
      end

      it "reads the charge of a preorder from the authorization purchase when the charge has no url redirect", parity: true do
        charge = charge_purchase

        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("purchase_id" => charge.external_id)
      end

      it "hands a preorder whose charge purchase has a url redirect to Rails", parity: true do
        charge = charge_purchase
        create(:url_redirect, purchase: charge, link: preorder_product)

        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]).to include("purchase_id" => charge.external_id, "url_redirect_token" => be_present)
      end

      it "hands a preorder whose seller has a post to Rails", parity: true do
        create(:installment, link: preorder_product, published_at: Time.current, shown_on_profile: true, send_emails: false)

        get "/mobile/purchases/purchase_attributes/#{authorization.external_id}", params: auth(buyer)

        expect(response.parsed_body["product"]["product_updates_data"].size).to eq(1)
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

    describe "showing a sale" do
      # Minted first so little time passes between the factories and the request: the fixture stores their timestamps relative to it.
      let!(:credentials) { auth(seller) }
      let(:sale) { library_purchase }

      def show(sale = self.sale) = get("/mobile/sales/#{sale.external_id}", params: credentials)

      it "serves the seller's own sale", parity: true do
        show

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body.keys).to eq(%w[success purchase customer charges emails product_purchases can_ping])
        expect(response.parsed_body["purchase"]["formatted_total_price"]).to be_present
      end

      it "serves a sale of a guest buyer", parity: true do
        guest = purchase_row(link: product, seller:, purchase_state: "successful", email: "guest@example.com", full_name: " Gus Guest ")

        show(guest)

        expect(response.parsed_body["purchase"]["full_name"]).to eq("Gus Guest")
      end

      it "serves a sale with its files", parity: true do
        create(:readable_document, link: product, position: 0)
        create(:url_redirect, purchase: sale, link: product)

        show

        expect(response.parsed_body["purchase"]["file_data"].size).to eq(1)
      end

      it "serves a sale with a variant", parity: true do
        variant = create(:variant, variant_category: create(:variant_category, link: product, title: "Tier"), name: "Gold")
        sale.variant_attributes << variant

        show

        expect(response.parsed_body["purchase"]["variants"].values.first).to eq("title" => "Tier", "selected_variant" => { "id" => variant.external_id, "name" => "Gold" })
      end

      it "serves a sale with a percentage offer code", parity: true do
        priced = create(:product, user: seller, price_cents: 1000)
        code = create(:percentage_offer_code, user: seller, products: [priced], code: "quarter", amount_percentage: 25)
        discounted = purchase_row(link: priced, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", offer_code: code)

        show(discounted)

        expect(response.parsed_body["purchase"]["offer_code"]).to eq("code" => "quarter", "displayed_amount_off" => "25%")
      end

      it "serves a sale with an offer code of a fixed amount", parity: true do
        priced = create(:product, user: seller, price_cents: 1000)
        code = create(:offer_code, user: seller, products: [priced], code: "fiver", amount_cents: 550)
        discounted = purchase_row(link: priced, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", offer_code: code)

        show(discounted)

        expect(response.parsed_body["purchase"]["offer_code"]).to eq("code" => "fiver", "displayed_amount_off" => "$5.50")
      end

      it "serves a sale whose seller takes sale pings", parity: true do
        seller.update_column(:notification_endpoint, "https://example.com/ping")

        show

        expect(response.parsed_body["can_ping"]).to eq(true)
      end

      it "hands a sale of a seller with an unpublished post to Rails", parity: true do
        create(:installment, link: product, seller:, published_at: nil, shown_on_profile: true, send_emails: false)

        show

        expect(response).to have_http_status(:ok)
      end

      it "hands a sale of a seller with a published post to Rails", parity: true do
        create(:installment, link: product, seller:, published_at: 2.days.ago, shown_on_profile: true, send_emails: false)

        show

        expect(response).to have_http_status(:ok)
      end

      it "serves a sale of a SKU", parity: true do
        physical = create(:physical_product, user: seller, skus_enabled: true)
        sku = create(:sku, link: physical, name: "Large")
        sold = purchase_row(link: physical, seller:, purchase_state: "successful")
        sold.variant_attributes << sku

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["sku_id"]).to eq(sku.external_id)
        expect(purchase["sku_external_id"]).to eq(sku.external_id)
        expect(purchase["variants"]).to eq("Version" => { "is_sku" => true, "title" => "Version", "selected_variant" => { "id" => sku.external_id, "name" => "Large" } })
      end

      it "serves a sale of a SKU with a custom SKU under the title of the product's only category", parity: true do
        physical = create(:physical_product, user: seller, skus_enabled: true)
        create(:variant_category, link: physical, title: "Size")
        sku = create(:sku, link: physical, name: "Large", custom_sku: "LRG-1")
        sold = purchase_row(link: physical, seller:, purchase_state: "successful")
        sold.variant_attributes << sku

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["sku_id"]).to eq("LRG-1")
        expect(purchase["sku_external_id"]).to eq(sku.external_id)
        expect(purchase["variants"].keys).to eq(["Size"])
      end

      it "serves a sale of a SKU of a product with two categories", parity: true do
        physical = create(:physical_product, user: seller, skus_enabled: true)
        create(:variant_category, link: physical, title: "Size")
        create(:variant_category, link: physical, title: "Color")
        sold = purchase_row(link: physical, seller:, purchase_state: "successful")
        sold.variant_attributes << create(:sku, link: physical, name: "Large")

        show(sold)

        expect(response).to have_http_status(:ok)
      end

      it "serves a sale of a default SKU", parity: true do
        physical = create(:physical_product, user: seller, skus_enabled: true)
        sold = purchase_row(link: physical, seller:, purchase_state: "successful")
        default_sku = create(:sku, link: physical, name: "Default", is_default_sku: true)
        sold.variant_attributes << default_sku

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["sku_id"]).to eq(default_sku.external_id)
        expect(purchase["variants"]).to eq("Version" => { "is_sku" => true, "title" => "Version", "selected_variant" => { "id" => default_sku.external_id, "name" => "Default" } })
      end

      it "serves a sale with a shipment that has not shipped", parity: true do
        physical = create(:physical_product, user: seller)
        sold = purchase_row(:physical_purchase, link: physical, seller:, purchase_state: "successful")
        Shipment.new(purchase: sold).save!(validate: false)

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["shipped"]).to eq(false)
        expect(purchase["tracking_url"]).to be_nil
        expect(purchase["shipping_address"].keys).to eq(%w[full_name street_address city state zip_code country])
        expect(purchase["shipping_address"]["street_address"]).to eq(sold.street_address)
      end

      it "serves a sale with a shipped shipment and its tracking link", parity: true do
        physical = create(:physical_product, user: seller)
        sold = purchase_row(:physical_purchase, link: physical, seller:, purchase_state: "successful")
        Shipment.new(purchase: sold, shipped_at: 1.day.ago, carrier: "UPS", tracking_number: "1Z999").save!(validate: false)

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["shipped"]).to eq(true)
        expect(purchase["tracking_url"]).to eq("http://wwwapps.ups.com/WebTracking/processInputRequest?TypeOfInquiryNumber=T&InquiryNumber1=1Z999")
      end

      it "serves a sale with a tracking link that is not http or https", parity: true do
        physical = create(:physical_product, user: seller)
        sold = purchase_row(:physical_purchase, link: physical, seller:, purchase_state: "successful")
        Shipment.new(purchase: sold, tracking_url: "ftp://example.com/track").save!(validate: false)

        show(sold)

        purchase = response.parsed_body["purchase"]
        expect(purchase["shipped"]).to eq(false)
        expect(purchase["tracking_url"]).to be_nil
      end

      it "serves a sale with an affiliate and the credit it earned", parity: true do
        affiliate = create(:direct_affiliate, seller:, affiliate_user: create(:user, email: "affiliate@example.com"), products: [product])
        referred = purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", affiliate:)
        referred.update_column(:affiliate_credit_cents, 150)

        show(referred)

        expect(response.parsed_body["purchase"]["affiliate"]).to eq("email" => "affiliate@example.com", "amount" => "$1.50")
      end

      it "serves a sale with an affiliate's unconfirmed email and a credit in whole dollars", parity: true do
        affiliate_user = create(:user, email: "affiliate@example.com")
        affiliate_user.update_column(:unconfirmed_email, "new-affiliate@example.com")
        affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product])
        referred = purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", affiliate:)
        referred.update_column(:affiliate_credit_cents, 200)

        show(referred)

        expect(response.parsed_body["purchase"]["affiliate"]).to eq("email" => "new-affiliate@example.com", "amount" => "$2")
      end

      it "hands a sale with a collaborator and a direct affiliate to Rails", parity: true do
        collaborator = create(:collaborator, seller:, affiliate_user: create(:user), products: [product])
        direct = create(:direct_affiliate, seller:, affiliate_user: create(:user), products: [product])
        referred = purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", affiliate: collaborator)
        referred.update_columns(affiliate_credit_cents: 100, json_data: { "direct_affiliate_id" => direct.id })

        show(referred)

        expect(response).to have_http_status(:ok)
      end

      it "hands a sale with several variants to Rails", parity: true do
        category = create(:variant_category, link: product)
        sale.variant_attributes << create(:variant, variant_category: category, name: "One")
        sale.variant_attributes << create(:variant, variant_category: create(:variant_category, link: product, title: "Other"), name: "Two")

        show

        expect(response).to have_http_status(:ok)
      end

      it "hands a sale of a membership to Rails", parity: true do
        membership = create(:membership_product, user: seller)
        recurring = purchase_row(link: membership, seller:, purchase_state: "successful", is_original_subscription_purchase: true, subscription: create(:subscription, link: membership, user: buyer))

        show(recurring)

        expect(response).to have_http_status(:ok)
      end

      it "serves a sale in another currency at its stored rate", parity: true do
        euro = purchase_row(link: product, seller:, purchase_state: "successful", price_cents: 1250, displayed_price_cents: 1000, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.81")

        show(euro)

        expect(response.parsed_body["purchase"].slice("currency_symbol", "amount_refundable_in_currency", "formatted_total_price")).to eq("currency_symbol" => "€", "amount_refundable_in_currency" => "10.13", "formatted_total_price" => "€10.13")
      end

      it "serves a sale in a single-unit currency at its stored rate", parity: true do
        yen = purchase_row(link: product, seller:, purchase_state: "successful", price_cents: 1000, displayed_price_cents: 1500, displayed_price_currency_type: "jpy", rate_converted_to_usd: "150.0")

        show(yen)

        expect(response.parsed_body["purchase"].slice("currency_symbol", "amount_refundable_in_currency", "formatted_total_price")).to eq("currency_symbol" => "¥", "amount_refundable_in_currency" => "1,500", "formatted_total_price" => "¥1,500")
      end
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

    it "serves a sales page with sales in other currencies at their stored rates", parity: true do
      purchase_row(link: product, seller:, purchase_state: "successful", price_cents: 1250, displayed_price_cents: 1000, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.81")
      purchase_row(link: product, seller:, purchase_state: "successful", price_cents: 1000, displayed_price_cents: 1500, displayed_price_currency_type: "jpy", rate_converted_to_usd: "150.0")
      index_model_records(Purchase)

      get "/mobile/sales", params: auth(seller)

      expect(response.parsed_body["purchases"].map { |sale| sale.slice("price", "formatted_total_price") }).to match_array([{ "price" => "€10", "formatted_total_price" => "€10.13" }, { "price" => "¥1,500", "formatted_total_price" => "¥1,500" }])
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
