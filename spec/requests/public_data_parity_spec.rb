# frozen_string_literal: true

require "spec_helper"

# PublicController's lookup endpoints (charge_data, license_key_lookup_data, paypal_charge_data), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws11-public.replay.test.ts.
describe "Public lookup data", type: :request do
  before { host! DOMAIN }

  let(:email) { "buyer@example.com" }
  # Creating a purchase through the factory charges a card; a lookup only reads the row.
  def purchase_row(product:, **attributes)
    build(:purchase, link: product, price_cents: 100, fee_cents: 30, email:, **attributes).tap { |row| row.save!(validate: false) }
  end

  let!(:purchase) { purchase_row(product: create(:product, name: "Sketch pack", unique_permalink: "sketchpk"), card_visual: "**** 4242", created_at: Time.utc(2024, 3, 15, 12)) }
  let!(:other_purchase) { purchase_row(product: create(:product, name: "Brush set", unique_permalink: "brushset"), card_visual: "**** 1111", created_at: Time.utc(2023, 7, 1, 12)) }

  describe "GET /charge_data" do
    it "emails a grouped receipt for every successful purchase of the address", parity: true do
      get "/charge_data", params: { email: }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by the last four digits of the card", parity: true do
      get "/charge_data", params: { email:, last_4: "4242" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by year and month", parity: true do
      get "/charge_data", params: { email:, year: "2023", month: "7" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by year alone when the month is out of range", parity: true do
      get "/charge_data", params: { email:, year: "2024", month: "13" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "ignores a year before the first purchases", parity: true do
      get "/charge_data", params: { email:, year: "2005", month: "3" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure when nothing matches", parity: true do
      get "/charge_data", params: { email:, last_4: "9999" }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for an address with no purchases", parity: true do
      get "/charge_data", params: { email: "nobody@example.com" }

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /license_key_lookup_data" do
    it "emails every purchase with recommendations when no product is named", parity: true do
      get "/license_key_lookup_data", params: { email: }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows to the product named by a partial name", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "sketch" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows to the product named by its URL", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "https://example.com/l/brushset" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "falls back to every purchase when the product query matches nothing", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "no such product" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure for an address with no purchases", parity: true do
      get "/license_key_lookup_data", params: { email: "nobody@example.com", product_query: "sketch" }

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /paypal_charge_data" do
    it "enqueues the receipt for the purchase", parity: true do
      get "/paypal_charge_data", params: { invoice_id: purchase.external_id }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure for an unknown invoice", parity: true do
      get "/paypal_charge_data", params: { invoice_id: "unknown-invoice" }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure without an invoice", parity: true do
      get "/paypal_charge_data"

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
