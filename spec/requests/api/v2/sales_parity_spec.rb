# frozen_string_literal: true

require "spec_helper"

# Api::V2::SalesController#summary, #revoke_access and #undo_revoke_access, which the Next.js port serves itself, and #refund and
# #mark_as_shipped, which it answers the 404 of and hands back otherwise (nextjs/src/server/controllers/api-v2/sales.ts). Recorded
# with PARITY_RECORD=1 and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 sales", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::ApiV2Requests
  include Parity::MobileApi

  let(:seller) { create(:user, name: "Sales Seller", email: "sales-seller@example.com", timezone: "Pacific Time (US & Canada)") }
  let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha") }
  let(:other_product) { create(:product, user: seller, name: "Beta", unique_permalink: "beta") }
  let(:sale) { purchase_row(link: product, seller:, email: "buyer@example.com", purchase_state: "successful") }
  # The examples that write run `update!`, which revalidates: a row saved with `validate: false` fails it.
  let(:valid_sale) { create(:free_purchase, link: create(:product, user: seller, price_cents: 0), email: "buyer@example.com") }

  PARITY_NOW = Time.utc(2026, 11, 2, 15, 0, 0)

  # The replay freezes its clock on the same instant: the summary's dates, its hour buckets and a DST change on the recorded week stay put.
  before { travel_to(PARITY_NOW) }

  after { travel_back }

  def sale_call(verb, action, purchase, scopes: "edit_sales", token: api_token(seller, scopes:))
    api_call(verb, "/sales/#{purchase.external_id}/#{action}", token:)
  end

  describe "PUT /sales/:id/revoke_access" do
    it "revokes access to a sale", parity: true do
      sale_call(:put, "revoke_access", valid_sale)

      expect(response.parsed_body["success"]).to eq(true)
      expect(valid_sale.reload.is_access_revoked).to eq(true)
    end

    it "revokes access through the /api prefix on the Gumroad domain", parity: true do
      api_call(:put, "/sales/#{valid_sale.external_id}/revoke_access", token: api_token(seller, scopes: "edit_sales"), api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "refuses a sale whose access is already revoked", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_access_revoked])

      sale_call(:put, "revoke_access", sale)

      expect(response.parsed_body).to eq("success" => false, "message" => "Access cannot be revoked for this sale.")
    end

    it "refuses a refunded sale", parity: true do
      sale.update_column(:stripe_refunded, true)

      sale_call(:put, "revoke_access", sale)

      expect(response.parsed_body["message"]).to eq("Access cannot be revoked for this sale.")
      expect(sale.reload.is_access_revoked).to eq(false)
    end

    it "refuses a sale of a physical product", parity: true do
      physical = purchase_row(link: create(:physical_product, user: seller), seller:, purchase_state: "successful")

      sale_call(:put, "revoke_access", physical)

      expect(response.parsed_body["message"]).to eq("Access cannot be revoked for this sale.")
    end

    it "does not find a sale of another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      sale_call(:put, "revoke_access", other)

      expect(response.parsed_body).to eq("success" => false, "message" => "The sale was not found.")
    end

    it "refuses a token with the legacy account scope", parity: true do
      sale_call(:put, "revoke_access", valid_sale, scopes: "account")

      expect(valid_sale.reload.is_access_revoked).to eq(false)
    end

    it "refuses a token without the edit_sales scope", parity: true do
      sale_call(:put, "revoke_access", valid_sale, scopes: "view_sales")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "PUT /sales/:id/undo_revoke_access" do
    it "restores access to a sale", parity: true do
      valid_sale.update!(is_access_revoked: true)

      sale_call(:put, "undo_revoke_access", valid_sale)

      expect(response.parsed_body["success"]).to eq(true)
      expect(valid_sale.reload.is_access_revoked).to eq(false)
    end

    it "refuses a sale whose access is not revoked", parity: true do
      sale_call(:put, "undo_revoke_access", sale)

      expect(response.parsed_body).to eq("success" => false, "message" => "Access is not revoked for this sale.")
    end

    it "does not find a sale that does not exist", parity: true do
      api_call(:put, "/sales/nonexistent/undo_revoke_access", token: api_token(seller, scopes: "edit_sales"))

      expect(response.parsed_body["message"]).to eq("The sale was not found.")
    end

    it "refuses a token with the legacy account scope", parity: true do
      sale_call(:put, "undo_revoke_access", sale, scopes: "account")
    end
  end

  describe "PUT /sales/:id/refund" do
    it "does not find a sale of another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      sale_call(:put, "refund", other, scopes: "refund_sales")

      expect(response.parsed_body).to eq("success" => false, "message" => "The sale was not found.")
    end

    # Without a merchant account Rails raises inside the refund; the recording needs the response of a refund that did not go through.
    before { allow_any_instance_of(Purchase).to receive(:refund!).and_return(false) }

    it "hands back a refund of a sale to Rails", parity: true do
      sale_call(:put, "refund", sale, scopes: "refund_sales")
    end

    it "hands back a refund with an amount to Rails", parity: true do
      api_call(:put, "/sales/#{sale.external_id}/refund", token: api_token(seller, scopes: "edit_sales"), params: { amount_cents: 100 })
    end

    it "hands back a refund of an already refunded sale to Rails", parity: true do
      sale.update_column(:stripe_refunded, true)

      sale_call(:put, "refund", sale, scopes: "refund_sales")
    end

    it "refuses a token without a refund scope", parity: true do
      sale_call(:put, "refund", sale, scopes: "view_sales")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "PUT /sales/:id/mark_as_shipped" do
    it "does not find a sale of another seller", parity: true do
      other = purchase_row(link: create(:physical_product), seller: create(:user), purchase_state: "successful")

      sale_call(:put, "mark_as_shipped", other, scopes: "mark_sales_as_shipped")

      expect(response.parsed_body).to eq("success" => false, "message" => "The sale was not found.")
    end

    it "hands back a shipment of a sale to Rails", parity: true do
      physical = purchase_row(link: create(:physical_product, user: seller), seller:, purchase_state: "successful")

      api_call(:put, "/sales/#{physical.external_id}/mark_as_shipped", token: api_token(seller, scopes: "mark_sales_as_shipped"), params: { tracking_url: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=9400111899223197428490" })
    end

    it "refuses a token without the mark_sales_as_shipped scope", parity: true do
      sale_call(:put, "mark_as_shipped", sale, scopes: "view_sales")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "GET /sales/:id" do
    let(:priced) { create(:product, user: seller, name: "Priced", price_cents: 1000) }
    let(:physical) { create(:physical_product, user: seller, skus_enabled: true) }

    def show(purchase, scopes: "view_sales")
      api_call(:get, "/sales/#{purchase.external_id}", token: api_token(seller, scopes:))
    end

    def sold(link, **attributes) = purchase_row(link:, seller:, email: "buyer@example.com", purchase_state: "successful", **attributes)

    it "prints the offer code of a percentage discount", parity: true do
      code = create(:percentage_offer_code, user: seller, products: [priced], code: "quarter", amount_percentage: 25)

      show(sold(priced, offer_code: code))

      expect(response.parsed_body["sale"]["offer_code"]).to eq("code" => "quarter", "displayed_amount_off" => "25%", "name" => "quarter")
    end

    it "prints the offer code of a discount in dollars and cents", parity: true do
      code = create(:offer_code, user: seller, products: [priced], code: "fiver", amount_cents: 550)

      show(sold(priced, offer_code: code))

      expect(response.parsed_body["sale"]["offer_code"]["displayed_amount_off"]).to eq("$5.50")
    end

    it "prints the offer code of a discount in whole dollars", parity: true do
      code = create(:offer_code, user: seller, products: [priced], code: "two", amount_cents: 200)

      show(sold(priced, offer_code: code))

      expect(response.parsed_body["sale"]["offer_code"]["displayed_amount_off"]).to eq("$2")
    end

    it "prints the affiliate and the credit it earned", parity: true do
      affiliate = create(:direct_affiliate, seller:, affiliate_user: create(:user, email: "affiliate@example.com"), products: [product])

      referred = sold(product, affiliate:)
      referred.update_column(:affiliate_credit_cents, 150)

      show(referred)

      expect(response.parsed_body["sale"]["affiliate"]).to eq("email" => "affiliate@example.com", "amount" => "$1.50")
    end

    it "prints the affiliate's unconfirmed email and a credit in whole dollars", parity: true do
      affiliate_user = create(:user, email: "affiliate@example.com")
      affiliate_user.update_column(:unconfirmed_email, "new-affiliate@example.com")
      affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product])

      referred = sold(product, affiliate:)
      referred.update_column(:affiliate_credit_cents, 200)

      show(referred)

      expect(response.parsed_body["sale"]["affiliate"]).to eq("email" => "new-affiliate@example.com", "amount" => "$2")
    end

    it "prints a sale of a SKU", parity: true do
      sku = create(:sku, link: physical, name: "Large", price_difference_cents: 250)
      purchase = sold(physical)
      purchase.variant_attributes << sku

      show(purchase)

      expect(response.parsed_body["sale"]).to include("variants" => { "Version" => "Large" }, "sku_external_id" => sku.external_id, "variants_price_cents" => 250)
    end

    it "prints the custom id of a SKU", parity: true do
      sku = create(:sku, link: physical, name: "Medium", custom_sku: "M-100")
      purchase = sold(physical)
      purchase.variant_attributes << sku

      show(purchase)

      expect(response.parsed_body["sale"]["sku_id"]).to eq("M-100")
    end

    it "prints a SKU under the title of the product's only category", parity: true do
      create(:variant_category, link: physical, title: "Size")
      sku = create(:sku, link: physical, name: "Small")
      purchase = sold(physical)
      purchase.variant_attributes << sku

      show(purchase)

      expect(response.parsed_body["sale"]["variants"]).to eq("Size" => "Small")
    end

    it "prints a sale with a variant from each of two categories", parity: true do
      size = create(:variant, variant_category: create(:variant_category, link: product, title: "Size"), name: "Large", price_difference_cents: 100)
      color = create(:variant, variant_category: create(:variant_category, link: product, title: "Color"), name: "Red", price_difference_cents: 50)
      purchase = sold(product, quantity: 2)
      purchase.variant_attributes << color
      purchase.variant_attributes << size

      show(purchase)

      expect(response.parsed_body["sale"]).to include("variants" => { "Color" => "Red", "Size" => "Large" }, "variants_and_quantity" => "(Red, Large, Qty: 2)", "variants_price_cents" => 150)
    end

    it "hands back a sale with two variants of one category", parity: true do
      category = create(:variant_category, link: product, title: "Size")
      purchase = sold(product)
      purchase.variant_attributes << create(:variant, variant_category: category, name: "Small")
      purchase.variant_attributes << create(:variant, variant_category: category, name: "Large")

      show(purchase)
    end

    describe "tracking URL" do
      let(:shipped) { sold(create(:physical_product, user: seller), country: "United States") }

      def ship(**attributes) = Shipment.new(purchase: shipped, **attributes).save!(validate: false)

      it "prints the stored link", parity: true do
        ship(tracking_url: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=9400111899223197428490")

        show(shipped)

        expect(response.parsed_body["sale"]["tracking_url"]).to eq("https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=9400111899223197428490")
      end

      it "prints a link the seller typed with spaces around it", parity: true do
        ship(tracking_url: "  https://example.com/track/abc-123?ref=a%20b#top \n")

        show(shipped)

        expect(response.parsed_body["sale"]["tracking_url"]).to eq("https://example.com/track/abc-123?ref=a%20b#top")
      end

      it "builds the link from a carrier and a tracking number", parity: true do
        ship(carrier: "UPS", tracking_number: "1Z999AA10123456784")

        show(shipped)

        expect(response.parsed_body["sale"]["tracking_url"]).to start_with("http://wwwapps.ups.com/")
      end

      it "prints no link for a shipment without one", parity: true do
        ship(tracking_url: "")

        show(shipped)

        expect(response.parsed_body["sale"]).to include("shipped" => false, "tracking_url" => nil)
      end

      it "prints no link for a carrier the form does not know", parity: true do
        ship(carrier: "Pigeon Post", tracking_number: "42")

        show(shipped)

        expect(response.parsed_body["sale"]["tracking_url"]).to be_nil
      end

      it "hands back a link that is not http or https", parity: true do
        ship(tracking_url: "ftp://example.com/track")

        show(shipped)
      end

      it "hands back a link with a space inside", parity: true do
        ship(tracking_url: "https://example.com/track me")

        show(shipped)
      end
    end
  end

  describe "GET /sales/summary" do
    before { Purchase.__elasticsearch__.create_index!(force: true) }

    def sell(item, days_ago:, hour: 10, price_cents: 500, **attributes)
      created_at = days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: 30).utc
      purchase_row(link: item, seller:, price_cents:, created_at:, purchase_state: "successful", **attributes)
    end

    def refund(purchase, amount_cents)
      Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, amount_cents:, fee_cents: 0).save!(validate: false)
    end

    def seed_sales
      sell(product, days_ago: 6)
      sell(product, days_ago: 6, hour: 14, price_cents: 900)
      sell(product, days_ago: 4)
      sell(other_product, days_ago: 3, price_cents: 1200)
      refund(sell(other_product, days_ago: 1, price_cents: 300, stripe_refunded: true), 300)
      refund(sell(other_product, days_ago: 1, hour: 18, price_cents: 700), 200)
      sell(other_product, days_ago: 1, hour: 19, price_cents: 800, purchase_state: "failed")
      sell(create(:product, user: create(:user)), days_ago: 2)
      index_model_records(Purchase)
    end

    def summary(token: api_token(seller, scopes: "view_sales"), **params)
      api_call(:get, "/sales/summary", token:, params:)
    end

    def day(days_ago)
      days_ago.days.ago.in_time_zone(seller.timezone).to_date.to_s
    end

    it "sums the last 30 days of an account with no sales", parity: true do
      summary
    end

    it "sums the sales of the last 30 days", parity: true do
      seed_sales

      summary
    end

    it "sums a range of days", parity: true do
      seed_sales

      summary(from: day(4), to: day(2))
    end

    it "sums a range that ends today when only from is given", parity: true do
      seed_sales

      summary(from: day(3))
    end

    it "breaks the sales down by product", parity: true do
      seed_sales

      summary(group_by: "product", from: day(6), to: day(0))
    end

    it "breaks the sales down by day", parity: true do
      seed_sales

      summary(group_by: "day", from: day(6), to: day(0))
    end

    it "breaks the sales down by week", parity: true do
      seed_sales

      summary(group_by: "week", from: day(20), to: day(0))
    end

    it "breaks the sales down by month", parity: true do
      seed_sales
      sell(product, days_ago: 40, price_cents: 1000)
      index_model_records(Purchase)

      summary(group_by: "month", from: day(60), to: day(0))
    end

    it "breaks the sales down by hour", parity: true do
      seed_sales

      summary(group_by: "hour", from: day(6), to: day(1))
    end

    it "merges the two buckets of an hour that daylight saving repeats", parity: true do
      [Time.utc(2026, 11, 1, 8, 30), Time.utc(2026, 11, 1, 9, 30)].each do |created_at|
        purchase_row(link: product, seller:, price_cents: 500, created_at:, purchase_state: "successful")
      end
      index_model_records(Purchase)

      summary(group_by: "hour", from: "2026-11-01", to: "2026-11-01")
    end

    it "breaks down a product that was deleted", parity: true do
      seed_sales
      product.update_columns(deleted_at: Time.current)

      summary(group_by: "product", from: day(6), to: day(0))
    end

    it "reads a token with the account scope", parity: true do
      seed_sales

      summary(token: api_token(seller, scopes: "account"), group_by: "day", from: day(4), to: day(3))
    end

    it "answers 400 for a group_by that is not a group", parity: true do
      summary(group_by: "year")
    end

    it "answers 400 for a from that is not a date", parity: true do
      summary(from: "last-week")
    end

    it "answers 400 for a to that is not a date", parity: true do
      summary(from: "2026-10-01", to: "2026-02-30")
    end

    it "answers 400 when from is after to", parity: true do
      summary(from: "2026-10-05", to: "2026-10-01")
    end

    it "answers 400 for an hourly range past a week", parity: true do
      summary(group_by: "hour", from: "2026-10-01", to: "2026-10-09")
    end

    it "ignores blank parameters", parity: true do
      summary(from: "", to: " ", group_by: "")
    end

    it "refuses a token without the view_sales scope", parity: true do
      summary(token: api_token(seller, scopes: "edit_products"))

      expect(response).to have_http_status(:forbidden)
    end
  end
end
